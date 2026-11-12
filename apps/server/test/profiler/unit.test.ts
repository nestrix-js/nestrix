/**
 * Remote profiling without a database: the summary code stays identical to the embedded
 * profiler's, the upload validator, the body parsers, the ingest path pattern, and which stamps
 * the guards let reach the new controllers.
 */
import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type ExecutionContext, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { AUTH_STAMP, TOKEN_READ_ROUTE } from "../../src/auth/admin-auth.js";
import { AdminAuthGuard } from "../../src/auth/auth.guard.js";
import { IngestController } from "../../src/ingest/ingest.controller.js";
import { INGEST_PATH_PATTERN } from "../../src/ingest/tokens.js";
import {
  MAX_FRAME_STRING,
  readCpuProfile,
} from "../../src/profiler/cpuprofile.js";
import { InstanceController } from "../../src/profiler/instance.controller.js";
import { normalizeProfile } from "../../src/profiler/normalize.js";
import {
  cleanText,
  parseCheckIn,
  parseFailed,
  parseRuntimeSample,
  parseStart,
  RUNTIME_BOUNDS,
} from "../../src/profiler/parse.js";
import {
  downloadName,
  RemoteProfilesController,
} from "../../src/profiler/remote-profiles.controller.js";
import { QueryController } from "../../src/query/query.controller.js";
import { sampleProfile } from "./helpers.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe("the summary code is the embedded profiler's", () => {
  it("src/profiler/normalize.ts is a copy of packages/nestjs/src/profiler/normalize.ts below its first line", async () => {
    const original = await readFile(
      here("../../../../packages/nestjs/src/profiler/normalize.ts"),
      "utf8",
    );
    const copy = await readFile(
      here("../../src/profiler/normalize.ts"),
      "utf8",
    );
    const [first, ...rest] = copy.split("\n");
    expect(first).toMatch(
      /^\/\/ Copy of packages\/nestjs\/src\/profiler\/normalize\.ts/,
    );
    expect(rest.join("\n")).toBe(original);
  });
});

describe("readCpuProfile", () => {
  it("accepts V8's shape and rebuilds it from the known fields", () => {
    const raw = { ...sampleProfile(), extra: 1 } as Record<string, unknown>;
    const first = (raw.nodes as Array<Record<string, unknown>>)[0];
    if (first) first.junk = "x";
    const result = readCpuProfile(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.profile).sort()).toEqual(
      ["endTime", "nodes", "samples", "startTime", "timeDeltas"].sort(),
    );
    expect(result.profile.nodes[0]).not.toHaveProperty("junk");
    expect(result.profile.nodes[4]?.callFrame.scriptId).toBe("7");
    // The shared summary code reads it.
    const summary = normalizeProfile(JSON.stringify(result.profile));
    expect(summary.samples).toBe(7);
    expect(summary.topFunctions[0]?.functionName).toBe("work");
  });

  it("accepts a real profile from v8.startCpuProfile (what the SDK uploads)", async () => {
    const v8 = (await import("node:v8")) as unknown as {
      startCpuProfile(options: {
        sampleInterval: number;
        maxBufferSize: number;
      }): {
        stop(): string;
      };
    };
    const handle = v8.startCpuProfile({
      sampleInterval: 1,
      maxBufferSize: 10_000,
    });
    const until = Date.now() + 30;
    let x = 0;
    while (Date.now() < until) x += Math.sqrt(x + 1);
    const raw = handle.stop();
    expect(x).toBeGreaterThan(0);
    const result = readCpuProfile(JSON.parse(raw));
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (result.ok) {
      const summary = normalizeProfile(JSON.stringify(result.profile));
      expect(summary.samples).toBeGreaterThan(0);
      expect(summary.flame.functionName).toBe("(root)");
    }
  });

  it("cuts long frame strings", () => {
    const raw = sampleProfile() as {
      nodes: Array<{ callFrame: { url: string } }>;
    };
    const work = raw.nodes[4];
    if (work) work.callFrame.url = "u".repeat(MAX_FRAME_STRING + 50);
    const result = readCpuProfile(raw);
    expect(result.ok && result.profile.nodes[4]?.callFrame.url.length).toBe(
      MAX_FRAME_STRING,
    );
  });

  it.each([
    ["not an object", 5],
    ["null", null],
    ["no nodes", { ...sampleProfile(), nodes: undefined }],
    ["empty nodes", { ...sampleProfile(), nodes: [] }],
    [
      "children not an array",
      {
        ...sampleProfile(),
        nodes: [{ id: 1, callFrame: {}, children: "abc" }],
      },
    ],
    [
      "a child that names no node",
      {
        ...sampleProfile(),
        nodes: [{ id: 1, callFrame: {}, children: [9] }],
        samples: [],
        timeDeltas: [],
      },
    ],
    [
      "duplicate ids",
      {
        ...sampleProfile(),
        nodes: [
          { id: 1, callFrame: {} },
          { id: 1, callFrame: {} },
        ],
        samples: [],
        timeDeltas: [],
      },
    ],
    [
      "a fractional id",
      { ...sampleProfile(), nodes: [{ id: 1.5, callFrame: {} }] },
    ],
    [
      "a sample that names no node",
      { ...sampleProfile(), samples: [42, 5, 5, 5, 5, 5, 5] },
    ],
    [
      "a string sample",
      { ...sampleProfile(), samples: ["5", 5, 5, 5, 5, 5, 5] },
    ],
    ["fewer deltas than samples", { ...sampleProfile(), timeDeltas: [1] }],
    [
      "a non-finite delta",
      { ...sampleProfile(), timeDeltas: [1, 1, 1, 1, 1, 1, "x"] },
    ],
    ["end before start", { ...sampleProfile(), endTime: 0 }],
    ["a string startTime", { ...sampleProfile(), startTime: "1" }],
    [
      "a non-string url",
      {
        ...sampleProfile(),
        nodes: [{ id: 1, callFrame: { url: 5 } }],
        samples: [],
        timeDeltas: [],
      },
    ],
    [
      "an object scriptId",
      {
        ...sampleProfile(),
        nodes: [{ id: 1, callFrame: { scriptId: {} } }],
        samples: [],
        timeDeltas: [],
      },
    ],
    [
      "bad positionTicks",
      {
        ...sampleProfile(),
        nodes: [{ id: 1, callFrame: {}, positionTicks: [{ line: "a" }] }],
        samples: [],
        timeDeltas: [],
      },
    ],
  ])("refuses %s", (_name, value) => {
    const result = readCpuProfile(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^not a CPU profile/);
  });

  it("never throws, even on a getter that throws", () => {
    const hostile = {
      get nodes(): never {
        throw new Error("boom");
      },
    };
    expect(readCpuProfile(hostile)).toEqual({
      ok: false,
      message: "not a CPU profile",
    });
  });

  it("a shared child (not a tree) still summarises without looping", () => {
    const raw = sampleProfile() as {
      nodes: Array<{ id: number; children?: number[] }>;
    };
    // (program) also points at work, and work back at main: a shared child and a cycle.
    const [, program, , , work] = raw.nodes;
    if (program) program.children = [5];
    if (work) work.children = [4];
    const result = readCpuProfile(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() =>
        normalizeProfile(JSON.stringify(result.profile)),
      ).not.toThrow();
    }
  });
});

describe("body parsers", () => {
  it("cleanText removes control characters, cuts and repairs a split surrogate pair", () => {
    expect(cleanText("a\u0000b\u001fc\u007fd", 10)).toBe("abcd");
    expect(cleanText("x😀", 2)).toBe("x�");
  });

  it("parseCheckIn keeps identities exact and drops what does not fit", () => {
    expect(
      parseCheckIn({
        service: "s",
        instanceId: "i",
        pid: 2 ** 31,
        runtime: "",
      }),
    ).toEqual({
      ok: true,
      checkIn: {
        service: "s",
        instanceId: "i",
        version: null,
        host: null,
        pid: null,
        runtime: null,
        sdkVersion: null,
        runningCaptureId: null,
        runtimeSample: null,
      },
    });
    expect(parseCheckIn({ service: "s".repeat(256), instanceId: "i" }).ok).toBe(
      true,
    );
    expect(parseCheckIn({ service: "s".repeat(257), instanceId: "i" }).ok).toBe(
      false,
    );
    expect(parseCheckIn({ service: "\uD800", instanceId: "i" }).ok).toBe(false);
    expect(parseCheckIn(null).ok).toBe(false);
  });

  it("P15-03: parseRuntimeSample keeps finite figures within bounds and drops the rest", () => {
    const at = 1_763_000_000_000;
    expect(
      parseRuntimeSample({
        cpuPercent: 12.5,
        eventLoopP99Ms: 0,
        heapUsedBytes: 10_000_000,
        rssBytes: 2 ** 50,
        sampledAtUnixMs: at,
        extra: "ignored",
      }),
    ).toEqual({
      cpuPercent: 12.5,
      eventLoopP99Ms: 0,
      heapUsedBytes: 10_000_000,
      rssBytes: 2 ** 50,
    });
    // Per figure: negative, non-finite, over the bound, a string: dropped, the rest kept.
    expect(
      parseRuntimeSample({
        cpuPercent: -1,
        eventLoopP99Ms: RUNTIME_BOUNDS.eventLoopP99Ms + 1,
        heapUsedBytes: "10",
        rssBytes: 5,
        sampledAtUnixMs: at,
      }),
    ).toEqual({
      cpuPercent: null,
      eventLoopP99Ms: null,
      heapUsedBytes: null,
      rssBytes: 5,
    });
    expect(
      parseRuntimeSample({
        cpuPercent: RUNTIME_BOUNDS.cpuPercent + 0.01,
        rssBytes: 2 ** 50 + 1,
        sampledAtUnixMs: at,
      }),
    ).toBeNull();
    // JSON cannot carry NaN or Infinity, but a caller passing parsed values might.
    expect(
      parseRuntimeSample({
        cpuPercent: Number.NaN,
        heapUsedBytes: Number.POSITIVE_INFINITY,
        sampledAtUnixMs: at,
      }),
    ).toBeNull();
    // The whole sample: not an object, an array, a bad timestamp.
    for (const bad of [
      null,
      "x",
      42,
      [1, 2],
      { cpuPercent: 1 },
      { cpuPercent: 1, sampledAtUnixMs: 0 },
      { cpuPercent: 1, sampledAtUnixMs: -5 },
      { cpuPercent: 1, sampledAtUnixMs: 1.5 },
      { cpuPercent: 1, sampledAtUnixMs: "1763000000000" },
      { cpuPercent: 1, sampledAtUnixMs: 2 ** 60 },
    ]) {
      expect(parseRuntimeSample(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("P15-03: a bad runtimeSample never fails the check-in; an absent one is null (old clients)", () => {
    const withBad = parseCheckIn({
      service: "s",
      instanceId: "i",
      runtimeSample: { cpuPercent: "high", sampledAtUnixMs: "now" },
    });
    expect(withBad.ok).toBe(true);
    expect(withBad.ok && withBad.checkIn.runtimeSample).toBeNull();
    const old = parseCheckIn({ service: "s", instanceId: "i", runtime: "v26" });
    expect(old.ok && old.checkIn.runtimeSample).toBeNull();
    expect(old.ok && old.checkIn.runtime).toBe("v26");
    const good = parseCheckIn({
      service: "s",
      instanceId: "i",
      runtimeSample: { rssBytes: 1, sampledAtUnixMs: 1 },
    });
    expect(good.ok && good.checkIn.runtimeSample).toEqual({
      cpuPercent: null,
      eventLoopP99Ms: null,
      heapUsedBytes: null,
      rssBytes: 1,
    });
  });

  it("parseFailed needs a string message and gives an empty one a default", () => {
    expect(parseFailed({ message: "  " })).toEqual({
      ok: true,
      message: "The instance reported a failure.",
    });
    expect(parseFailed({}).ok).toBe(false);
  });

  it("parseStart refuses unknown fields and bounds durationSeconds", () => {
    expect(parseStart({ service: "s", instanceId: "i" })).toEqual({
      ok: true,
      service: "s",
      instanceId: "i",
      durationSeconds: 30,
    });
    expect(
      parseStart({ service: "s", instanceId: "i", durationSeconds: 120 }).ok,
    ).toBe(true);
    expect(
      parseStart({ service: "s", instanceId: "i", durationSeconds: 121 }).ok,
    ).toBe(false);
    expect(
      parseStart({ service: "s", instanceId: "i", __proto__: { x: 1 } }).ok,
    ).toBe(true);
    expect(
      parseStart(JSON.parse('{"service":"s","instanceId":"i","__proto__":1}'))
        .ok,
    ).toBe(false);
  });

  it("downloadName is safe in a header and a file system", () => {
    expect(downloadName('a"b/c\r\n', 0, "0123456789abcdef")).toBe(
      "nestrix-a_b_c__-1970-01-01T00-00-00Z-0123456789abcdef.cpuprofile",
    );
  });
});

describe("routing and access", () => {
  it.each([
    "/v1/nestrix/check-in",
    "/V1/Nestrix/Check-In/",
    "/v1/nestrix/profiles/0123456789abcdef",
    "/v1/nestrix/profiles/anything",
    "/v1/nestrix/profiles/0123456789abcdef/failed",
    "/v1/traces",
    "/v1/logs/",
  ])("%s is an ingest-key path", (path) =>
    expect(INGEST_PATH_PATTERN.test(path)).toBe(true),
  );

  it.each([
    "/v1/nestrix",
    "/v1/nestrix/profiles",
    "/v1/nestrix/profiles/",
    "/v1/nestrix/profiles/a/b",
    "/v1/nestrix/profiles/a/failedx",
    "/v1/nestrix/check-inx",
    "/v1/nestrix/instances",
    "/api/v1/remote-profiles",
  ])("%s is not", (path) => expect(INGEST_PATH_PATTERN.test(path)).toBe(false));

  it.each([
    "/api/v1/instances",
    "/api/v1/remote-profiles",
    "/api/v1/remote-profiles/0123456789abcdef",
    "/api/v1/remote-profiles/0123456789abcdef/download",
  ])("a token may read %s", (path) =>
    expect(TOKEN_READ_ROUTE.test(path)).toBe(true),
  );

  it.each(["/api/v1/remote-profiles/a/b", "/api/v1/instances/x"])(
    "a token may not read %s",
    (path) => expect(TOKEN_READ_ROUTE.test(path)).toBe(false),
  );

  it("every GET route of RemoteProfilesController is a token read route; the one POST is not a GET", () => {
    const proto = RemoteProfilesController.prototype as unknown as Record<
      string,
      object
    >;
    const routes = Object.getOwnPropertyNames(proto)
      .filter((n) => n !== "constructor")
      .map((n) => ({
        method: Reflect.getMetadata(
          METHOD_METADATA,
          proto[n] as object,
        ) as RequestMethod,
        path: Reflect.getMetadata(PATH_METADATA, proto[n] as object) as string,
      }));
    expect(routes).toHaveLength(5);
    const posts = routes.filter((r) => r.method === RequestMethod.POST);
    expect(posts.map((r) => r.path)).toEqual(["remote-profiles"]);
    for (const r of routes.filter((r) => r.method === RequestMethod.GET)) {
      const concrete = r.path.replace(":id", "0123456789abcdef");
      expect(TOKEN_READ_ROUTE.test(`/api/v1/${concrete}`), r.path).toBe(true);
    }
  });

  const context = (
    stamp: string | undefined,
    method: string,
    target: unknown,
  ) =>
    ({
      getType: () => "http",
      getClass: () => target,
      switchToHttp: () => ({
        getRequest: () => ({ method, [AUTH_STAMP]: stamp }),
      }),
    }) as unknown as ExecutionContext;
  const allows = (ctx: ExecutionContext) => {
    try {
      return new AdminAuthGuard().canActivate(ctx);
    } catch {
      return false;
    }
  };

  it("the global guard: a token reaches RemoteProfilesController for GET/HEAD only; ingest reaches InstanceController only", () => {
    expect(allows(context("token", "GET", RemoteProfilesController))).toBe(
      true,
    );
    expect(allows(context("token", "HEAD", RemoteProfilesController))).toBe(
      true,
    );
    expect(allows(context("token", "POST", RemoteProfilesController))).toBe(
      false,
    );
    expect(allows(context("token", "GET", InstanceController))).toBe(false);
    expect(allows(context("ingest", "POST", InstanceController))).toBe(true);
    expect(allows(context("ingest", "POST", IngestController))).toBe(true);
    expect(allows(context("ingest", "POST", RemoteProfilesController))).toBe(
      false,
    );
    expect(allows(context("ingest", "GET", QueryController))).toBe(false);
    expect(allows(context("login", "POST", InstanceController))).toBe(false);
    expect(allows(context(undefined, "POST", InstanceController))).toBe(false);
    expect(allows(context("session", "POST", RemoteProfilesController))).toBe(
      true,
    );
  });
});
