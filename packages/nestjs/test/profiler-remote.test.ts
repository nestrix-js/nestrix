// P10-01: the remote profiler's check-in poller (src/profiler/remote.ts) against a fake standalone
// server. Short timings through the `timing` seam; real `fetch`, real sockets. One test takes a real
// one-second CPU capture and checks the gzipped upload parses as a `.cpuprofile`.
//
// Global state: the process-wide profiler slot (reset after each test).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstanceIdentity } from "../src/otel/resource.js";
import {
  type CaptureEndListener,
  getProfiler,
  resetProfilerForTests,
  type StartResult,
} from "../src/profiler/profiler.js";
import {
  type PollerProfiler,
  type PollerTiming,
  type RemotePollerConfig,
  RemoteProfilerPoller,
} from "../src/profiler/remote.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { closedPort, trackUncaught } from "./outbound-helpers.js";
import {
  bodyJson,
  CHECK_IN,
  type FakeServer,
  sleep,
  startFakeServer,
  until,
} from "./profiler-remote-fixture.js";

const ORDER_ID = "0123456789abcdef";
const PKG_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

const FAST: Partial<PollerTiming> = {
  firstMinMs: 5,
  firstMaxMs: 5,
  intervalMs: 50,
  minIntervalMs: 20,
  maxIntervalMs: 1000,
  jitter: 0,
  authRetryMs: 300,
  backoffStartMs: 40,
  backoffMaxMs: 160,
};

const IDENTITY: InstanceIdentity = {
  service: "orders",
  instanceId: "4a1f8a8e-3f7d-4c55-9a39-0d2a2d4a6b11",
  version: "1.2.3",
  host: "box-1",
};

let server: FakeServer;
let pollers: RemoteProfilerPoller[] = [];
let logs: string[] = [];
let diagnostics = recordingDiagnostics();
let uncaught = trackUncaught();
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

function poller(
  overrides: Partial<RemotePollerConfig> = {},
): RemoteProfilerPoller {
  const p = new RemoteProfilerPoller({
    target: {
      baseUrl: server.url,
      headers: { "x-nestrix-key": "ingest-key-1" },
      timeoutMillis: 2000,
    },
    identity: IDENTITY,
    diagnostics,
    log: (m) => logs.push(m),
    timing: FAST,
    ...overrides,
  });
  pollers.push(p);
  return p;
}

/** A profiler stand-in that answers `start` with `result` and records calls. */
function fakeProfiler(
  result: StartResult,
  onStart?: (listener: CaptureEndListener | undefined) => void,
): PollerProfiler & { starts: number[]; discards: object[] } {
  const starts: number[] = [];
  const discards: object[] = [];
  return {
    starts,
    discards,
    start(durationMs, _owner, onEnd) {
      starts.push(durationMs);
      onStart?.(onEnd);
      return result;
    },
    discard(owner) {
      discards.push(owner);
    },
  };
}

function orderOnce(durationMs = 1000, id = ORDER_ID) {
  let sent = false;
  server.respond = (hit) => {
    if (hit.path === CHECK_IN) {
      const capture = sent ? undefined : { id, durationMs };
      sent = true;
      return { status: 200, json: { capture, nextCheckInMs: 50 } };
    }
    return { status: 204 };
  };
}

beforeEach(async () => {
  server = await startFakeServer();
  logs = [];
  diagnostics = recordingDiagnostics();
  uncaught = trackUncaught();
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  resetProfilerForTests();
});

afterEach(async () => {
  for (const p of pollers) p.stop();
  pollers = [];
  resetProfilerForTests();
  await server.close();
  await sleep(10);
  process.off("unhandledRejection", onUnhandled);
  uncaught.stop();
  // Rule 1, for every test: nothing escaped into the process.
  expect(uncaught.errors).toEqual([]);
  expect(unhandled).toEqual([]);
});

describe("check-in", () => {
  it("posts the instance identity with the export headers", async () => {
    poller().start();
    await until(() => server.checkIns().length >= 1, 2000, "a check-in");
    const hit = server.checkIns()[0];
    expect(hit?.method).toBe("POST");
    expect(hit?.headers["content-type"]).toBe("application/json");
    expect(hit?.headers["x-nestrix-key"]).toBe("ingest-key-1");
    expect(hit?.headers.traceparent).toBeUndefined();
    const { runtimeSample, ...identity } = bodyJson(hit as never) as Record<
      string,
      unknown
    >;
    expect(identity).toEqual({
      service: "orders",
      instanceId: IDENTITY.instanceId,
      version: "1.2.3",
      host: "box-1",
      pid: process.pid,
      runtime: process.version,
      sdkVersion: PKG_VERSION,
    });
    // P15-03: the real process figures; no dashboard here, so no event-loop p99.
    expect(runtimeSample).toEqual({
      sampledAtUnixMs: expect.any(Number),
      cpuPercent: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      rssBytes: expect.any(Number),
    });
  });

  it("keeps checking in at the server's interval, clamped", async () => {
    server.respond = () => ({ status: 200, json: { nextCheckInMs: 1 } });
    poller().start();
    await until(() => server.checkIns().length >= 4, 2000, "four check-ins");
    const at = server.checkIns().map((h) => h.at);
    // nextCheckInMs 1 is clamped up to minIntervalMs (20).
    for (let i = 1; i < at.length; i++) {
      expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(15);
    }
  });

  it("the first check-in waits for firstMinMs, not inside start()", async () => {
    poller({ timing: { ...FAST, firstMinMs: 300, firstMaxMs: 300 } }).start();
    await sleep(150);
    expect(server.hits).toHaveLength(0);
    await until(() => server.checkIns().length === 1, 2000, "a check-in");
  });
});

type SampleBody = { runtimeSample?: Record<string, number> };
const sampleOf = (hit: unknown) =>
  (bodyJson(hit as never) as SampleBody).runtimeSample;

describe("runtime sample (P15-03)", () => {
  it("carries real CPU, heap and RSS figures on every check-in", async () => {
    const before = Date.now();
    poller().start();
    await until(() => server.checkIns().length >= 2, 2000, "two check-ins");
    for (const hit of server.checkIns().slice(0, 2)) {
      const sample = sampleOf(hit) ?? {};
      expect(sample.sampledAtUnixMs).toBeGreaterThanOrEqual(before);
      expect(sample.sampledAtUnixMs).toBeLessThanOrEqual(Date.now());
      expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(sample.heapUsedBytes).toBeGreaterThan(0);
      expect(sample.rssBytes).toBeGreaterThan(sample.heapUsedBytes ?? 0);
      expect(sample.eventLoopP99Ms).toBeUndefined();
    }
  });

  it("takes the event-loop p99 from the dashboard sampler when fresh, not when stale", async () => {
    let age = 1000;
    poller({
      latestRuntimeSample: () => ({
        timeUnixMs: Date.now() - age,
        eventLoopP50Ms: 1,
        eventLoopP99Ms: 42.5,
        eventLoopMaxMs: 80,
        heapUsedBytes: 1,
        heapTotalBytes: 2,
        rssBytes: 3,
        externalBytes: 4,
        cpuUserPercent: 5,
        cpuSystemPercent: 6,
        activeResources: 7,
      }),
    }).start();
    await until(() => server.checkIns().length >= 1, 2000, "a check-in");
    const first = sampleOf(server.checkIns()[0]) ?? {};
    expect(first.eventLoopP99Ms).toBe(42.5);
    // The dashboard's heap figure is not used: the check-in reads the process now.
    expect(first.heapUsedBytes).toBeGreaterThan(1);
    age = 31_000;
    const seen = server.checkIns().length;
    await until(
      () => server.checkIns().length > seen,
      2000,
      "a later check-in",
    );
    expect(sampleOf(server.checkIns().at(-1))?.eventLoopP99Ms).toBeUndefined();
  });

  it("a reader with nothing to send leaves the field out", async () => {
    poller({ runtime: { start() {}, read: () => undefined } }).start();
    await until(() => server.checkIns().length >= 1, 2000, "a check-in");
    const body = bodyJson(server.checkIns()[0] as never) as Record<
      string,
      unknown
    >;
    expect("runtimeSample" in body).toBe(false);
    expect(body.service).toBe("orders");
  });

  it("fault injection: a reader that throws in start and read never stops the check-in", async () => {
    let reads = 0;
    poller({
      runtime: {
        start() {
          throw new Error("start boom");
        },
        read() {
          reads++;
          throw new Error("read boom");
        },
      },
    }).start();
    await until(() => server.checkIns().length >= 2, 2000, "two check-ins");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(sampleOf(server.checkIns()[1])).toBeUndefined();
    const counted = diagnostics.failures.filter(
      (f) => f.where === "profiler.remote.runtime",
    );
    expect(counted.length).toBeGreaterThanOrEqual(3);
  });

  it("fault injection: a throwing dashboard source still sends CPU and memory", async () => {
    poller({
      latestRuntimeSample: () => {
        throw new Error("dashboard boom");
      },
    }).start();
    await until(() => server.checkIns().length >= 1, 2000, "a check-in");
    const sample = sampleOf(server.checkIns()[0]) ?? {};
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(sample.eventLoopP99Ms).toBeUndefined();
    expect(
      diagnostics.failures.some((f) => f.where === "profiler.remote.runtime"),
    ).toBe(true);
  });
});

describe("orders and uploads", () => {
  it("runs the ordered capture and uploads a gzipped .cpuprofile", async () => {
    orderOnce(1000);
    poller().start();
    const uploadPath = `/v1/nestrix/profiles/${ORDER_ID}`;
    await until(
      () => server.hits.some((h) => h.path === uploadPath),
      5000,
      "the upload",
    );
    const upload = server.hits.find((h) => h.path === uploadPath);
    expect(upload?.method).toBe("POST");
    expect(upload?.headers["content-type"]).toBe("application/json");
    expect(upload?.headers["content-encoding"]).toBe("gzip");
    expect(upload?.headers["x-nestrix-key"]).toBe("ingest-key-1");
    const profile = bodyJson(upload as never) as Record<string, unknown>;
    expect(Array.isArray(profile.nodes)).toBe(true);
    expect(Array.isArray(profile.samples)).toBe(true);
    expect(Array.isArray(profile.timeDeltas)).toBe(true);
    expect(typeof profile.startTime).toBe("number");
    expect(typeof profile.endTime).toBe("number");
    // While it ran, check-ins carried the order id.
    expect(
      server
        .checkIns()
        .some(
          (h) =>
            (bodyJson(h) as { runningCaptureId?: string }).runningCaptureId ===
            ORDER_ID,
        ),
    ).toBe(true);
    // After the upload, check-ins stop carrying it.
    const count = server.checkIns().length;
    await until(() => server.checkIns().length > count + 1, 2000);
    const last = server.checkIns().at(-1);
    expect(
      (bodyJson(last as never) as { runningCaptureId?: string })
        .runningCaptureId,
    ).toBeUndefined();
    // The capture also lands in this process's embedded list.
    expect(getProfiler().list().profiles).toHaveLength(1);
    expect(server.hits.some((h) => h.path.endsWith("/failed"))).toBe(false);
  }, 10_000);

  it("a start refused because another capture runs sends failed: busy", async () => {
    const other = {};
    expect(getProfiler().start(5000, other).outcome).toBe("started");
    orderOnce(1000);
    poller().start();
    const path = `/v1/nestrix/profiles/${ORDER_ID}/failed`;
    await until(() => server.hits.some((h) => h.path === path), 2000);
    const hit = server.hits.find((h) => h.path === path);
    expect(hit?.headers["x-nestrix-key"]).toBe("ingest-key-1");
    expect(bodyJson(hit as never)).toEqual({ message: "busy" });
    getProfiler().discard(other);
  });

  it.each([
    [{ outcome: "cooldown", retryAfterSeconds: 4 } as const, "cooldown"],
    [{ outcome: "busy", running: null } as const, "busy"],
    [
      {
        outcome: "failed",
        message: "v8.startCpuProfile is not available",
      } as const,
      "v8.startCpuProfile is not available",
    ],
  ])("start outcome %o sends failed with %s", async (result, message) => {
    const profiler = fakeProfiler(result);
    orderOnce(30_000);
    poller({ profiler }).start();
    const path = `/v1/nestrix/profiles/${ORDER_ID}/failed`;
    await until(() => server.hits.some((h) => h.path === path), 2000);
    expect(profiler.starts).toEqual([30_000]);
    expect(bodyJson(server.hits.find((h) => h.path === path) as never)).toEqual(
      { message },
    );
  });

  it("a capture that fails after starting sends failed with the reason", async () => {
    let listener: CaptureEndListener | undefined;
    const profiler = fakeProfiler(
      {
        outcome: "started",
        running: {
          id: "p1",
          startedAtUnixMs: 0,
          durationMs: 1000,
          endsAtUnixMs: 1000,
          startPauseMs: 1,
        },
      },
      (l) => {
        listener = l;
      },
    );
    orderOnce(1000);
    poller({ profiler }).start();
    await until(() => listener !== undefined, 2000);
    listener?.({
      outcome: "failed",
      id: "p1",
      message: "V8 returned no profile",
    });
    const path = `/v1/nestrix/profiles/${ORDER_ID}/failed`;
    await until(() => server.hits.some((h) => h.path === path), 2000);
    expect(bodyJson(server.hits.find((h) => h.path === path) as never)).toEqual(
      {
        message: "V8 returned no profile",
      },
    );
  });

  it("an order with an invalid id is ignored; an invalid duration is reported", async () => {
    const profiler = fakeProfiler({ outcome: "busy", running: null });
    orderOnce(1000, "../../etc/passwd");
    poller({ profiler }).start();
    await until(() => server.checkIns().length >= 3, 2000);
    expect(profiler.starts).toEqual([]);
    expect(server.hits.every((h) => h.path === CHECK_IN)).toBe(true);
    expect(diagnostics.logs.has("profiler.remote-bad-order")).toBe(true);

    orderOnce(999_999);
    await until(
      () => server.hits.some((h) => h.path.endsWith("/failed")),
      2000,
    );
    expect(profiler.starts).toEqual([]);
    expect(
      bodyJson(server.hits.find((h) => h.path.endsWith("/failed")) as never),
    ).toEqual({ message: "invalid capture duration" });
  });

  it("a refused upload (413) is reported as failed; 404 is not", async () => {
    const uploadPath = `/v1/nestrix/profiles/${ORDER_ID}`;
    let listener: CaptureEndListener | undefined;
    const started: StartResult = {
      outcome: "started",
      running: {
        id: "p2",
        startedAtUnixMs: 0,
        durationMs: 1000,
        endsAtUnixMs: 1000,
        startPauseMs: 1,
      },
    };
    let uploadStatus = 413;
    const profiler = fakeProfiler(started, (l) => {
      listener = l;
    });
    let sent = false;
    server.respond = (hit) => {
      if (hit.path === CHECK_IN) {
        const capture = sent ? undefined : { id: ORDER_ID, durationMs: 1000 };
        sent = true;
        return { status: 200, json: { capture, nextCheckInMs: 50 } };
      }
      if (hit.path === uploadPath) return { status: uploadStatus };
      return { status: 204 };
    };
    poller({ profiler }).start();
    await until(() => listener !== undefined, 2000);
    listener?.({
      outcome: "done",
      id: "p2",
      json: '{"nodes":[],"samples":[],"timeDeltas":[],"startTime":0,"endTime":1}',
      summary: {} as never,
    });
    await until(
      () => server.hits.some((h) => h.path.endsWith("/failed")),
      2000,
    );
    expect(
      bodyJson(server.hits.find((h) => h.path.endsWith("/failed")) as never),
    ).toEqual({ message: "upload refused: HTTP 413" });
    expect(logs.some((l) => l.includes("refused (HTTP 413)"))).toBe(true);

    // A second order whose upload gets 404: no failed report.
    server.hits.length = 0;
    listener = undefined;
    uploadStatus = 404;
    sent = false;
    await until(() => listener !== undefined, 2000);
    // Set again by the fake profiler's callback, which narrowing cannot see.
    (listener as CaptureEndListener | undefined)?.({
      outcome: "done",
      id: "p2",
      json: "{}",
      summary: {} as never,
    });
    await until(() => server.hits.some((h) => h.path === uploadPath), 2000);
    await sleep(100);
    expect(server.hits.some((h) => h.path.endsWith("/failed"))).toBe(false);
  });
});

describe("answers that are not 200", () => {
  it.each([404, 405])(
    "%i stops polling for good, with one log line",
    async (status) => {
      server.respond = () => ({ status });
      const p = poller();
      p.start();
      await until(() => server.hits.length === 1, 2000);
      await sleep(200);
      expect(server.hits).toHaveLength(1);
      expect(p.scheduled).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`answered ${status}`);
      expect(logs[0]).toContain("not a Nestrix server");
    },
  );

  it.each([401, 403])(
    "%i retries at the auth interval and logs once",
    async (status) => {
      server.respond = () => ({ status });
      poller().start();
      await until(() => server.hits.length === 2, 2000);
      const [a, b] = server.hits;
      // authRetryMs is 300 with no jitter.
      expect((b?.at ?? 0) - (a?.at ?? 0)).toBeGreaterThanOrEqual(280);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`answered ${status}`);

      server.respond = () => ({ status: 200, json: { nextCheckInMs: 50 } });
      await until(() => logs.length === 2, 2000);
      expect(logs[1]).toContain("works again");
    },
  );

  it("5xx backs off exponentially to the maximum, logging once", async () => {
    server.respond = () => ({ status: 503 });
    poller().start();
    await until(() => server.hits.length >= 5, 3000);
    const at = server.hits.map((h) => h.at);
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
    // 40, 80, 160, 160 (capped), measured with a little scheduling slack.
    expect(gaps[0]).toBeGreaterThanOrEqual(35);
    expect(gaps[1]).toBeGreaterThanOrEqual(75);
    expect(gaps[2]).toBeGreaterThanOrEqual(155);
    expect(gaps[3]).toBeGreaterThanOrEqual(155);
    expect(gaps[3]).toBeLessThan(300);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("HTTP 503");
  });

  it("a network error backs off and logs once", async () => {
    const port = await closedPort();
    let attempts = 0;
    const p = poller({
      target: {
        baseUrl: `http://127.0.0.1:${port}`,
        headers: {},
        timeoutMillis: 500,
      },
      fetch: (input, init) => {
        attempts++;
        return fetch(input, init);
      },
    });
    p.start();
    // Backoff 40, 80, 160 ms: a third attempt comes, and still one log line.
    await until(() => attempts >= 3, 3000, "three attempts");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("ECONNREFUSED");
  });

  it("a redirect is not followed (the key never goes elsewhere)", async () => {
    const elsewhere = await startFakeServer();
    try {
      server.respond = () => ({
        status: 307,
        headers: { location: `${elsewhere.url}/v1/nestrix/check-in` },
      });
      poller().start();
      await until(() => logs.length === 1, 2000);
      expect(logs[0]).toContain("HTTP 307");
      await sleep(100);
      expect(elsewhere.hits).toHaveLength(0);
    } finally {
      await elsewhere.close();
    }
  });

  it("a non-JSON or oversized answer counts as a failure", async () => {
    server.respond = () => ({ status: 200, json: "x".repeat(70 * 1024) });
    poller().start();
    await until(() => logs.length === 1, 2000);
    expect(logs[0]).toContain("unreadable answer");
  });

  it("a hanging server times out and backs off", async () => {
    server.respond = () => "hang";
    poller({
      target: { baseUrl: server.url, headers: {}, timeoutMillis: 100 },
    }).start();
    await until(() => logs.length === 1, 2000);
    expect(logs[0]).toContain("timed out");
    await until(() => server.aborted >= 1, 2000);
  });
});

describe("stop", () => {
  it("aborts the request in flight, clears the timer and discards its capture", async () => {
    server.respond = () => "hang";
    const profiler = fakeProfiler({ outcome: "busy", running: null });
    const p = poller({ profiler });
    p.start();
    await until(() => server.hits.length === 1, 2000);
    p.stop();
    await until(() => server.aborted === 1, 2000, "the abort");
    await p.idle();
    expect(p.scheduled).toBe(false);
    expect(profiler.discards).toEqual([p]);
    await sleep(150);
    expect(server.hits).toHaveLength(1);
    // A stop is not a failure.
    expect(logs).toEqual([]);
  });

  it("stop discards a real running capture and uploads nothing", async () => {
    orderOnce(5000);
    const p = poller();
    p.start();
    await until(() => getProfiler().list().running !== null, 2000);
    p.stop();
    expect(getProfiler().list().running).toBeNull();
    await sleep(100);
    expect(
      server.hits.some((h) => h.path.startsWith("/v1/nestrix/profiles")),
    ).toBe(false);
  });

  it("stop before start schedules nothing", async () => {
    const p = poller();
    p.stop();
    p.start();
    await sleep(50);
    expect(p.scheduled).toBe(false);
    expect(server.hits).toHaveLength(0);
  });
});

describe("faults never reach the application (rule 1)", () => {
  it("a throwing logger, fetch and profiler are contained", async () => {
    const throwingProfiler: PollerProfiler = {
      start() {
        throw new Error("start boom");
      },
      discard() {
        throw new Error("discard boom");
      },
    };
    orderOnce(1000);
    const p = poller({
      profiler: throwingProfiler,
      log: () => {
        throw new Error("log boom");
      },
    });
    p.start();
    await until(() => server.checkIns().length >= 2, 2000);
    expect(diagnostics.failures.map((f) => f.where)).toContain(
      "profiler.remote",
    );
    p.stop();

    let calls = 0;
    const q = poller({
      fetch: () => {
        calls++;
        throw new Error("fetch boom");
      },
      log: () => {
        throw new Error("log boom");
      },
    });
    q.start();
    // Each synchronous throw is a failure with backoff; polling carries on.
    await until(() => calls >= 3, 3000);
  });

  it("a fault while computing the next delay still schedules one (no unhandled rejection)", async () => {
    let calls = 0;
    poller({
      random: () => {
        calls++;
        // The first call picks the first delay; every later one throws.
        if (calls > 1) throw new Error("random boom");
        return 0;
      },
    }).start();
    // Falls back to backoffMaxMs (160 ms) and keeps polling.
    await until(() => server.checkIns().length >= 2, 2000, "a second check-in");
    expect(diagnostics.failures.map((f) => f.where)).toContain(
      "profiler.remote",
    );
  });

  it("a fetch that rejects with a non-Error and a body that errors are contained", async () => {
    let calls = 0;
    const p = poller({
      fetch: () => {
        calls++;
        return calls === 1
          ? Promise.reject("a string")
          : Promise.resolve(
              new Response(
                new ReadableStream({
                  start(c) {
                    c.error(new Error("body boom"));
                  },
                }),
                { status: 200 },
              ),
            );
      },
    });
    p.start();
    await until(() => calls >= 3, 2000);
    expect(logs[0]).toContain("unknown error");
  });
});
