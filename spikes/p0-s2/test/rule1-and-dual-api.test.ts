import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dbs,
  type FixtureResult,
  requireBuilt,
  runFixture,
  runNode,
  spikeRoot,
} from "./helpers.js";

requireBuilt();

const ALL_FAULTS = [
  "http.created",
  "http.finish",
  "channel:mysql2:query",
  "channel:mysql2:execute",
  "channel:ioredis:command",
  "pg.client.query",
  "pg.pool.query",
].join(",");

function stripIds(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(
        /"(spanId|traceId|a|b|offline|traceA|traceB)":"[0-9a-f]+"/g,
        '"$1":"<id>"',
      )
      .replace(/"settledMs":[0-9.]+|"bodyEndMs":[0-9.]+/g, '"t":0')
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
      // The redis scenario INCRs a shared counter.
      .replace(/\[null,\d+\]/g, '[null,"<n>"]'),
  );
}

describe("Rule 1: a throwing subscriber or wrapper body never reaches the host", () => {
  it("with a fault injected into every guarded body, every route answers exactly as without", async () => {
    const scenarios = ["out", "http-cases"];
    if (dbs.pg) scenarios.push("pg", "pg-contention");
    if (dbs.mysql) scenarios.push("mysql");
    if (dbs.redis) scenarios.push("redis");
    const [clean, faulty] = await Promise.all([
      runFixture("esm", scenarios),
      runFixture("esm", scenarios, { env: { NESTRIX_FAULTS: ALL_FAULTS } }),
    ]);
    const a = clean.result as FixtureResult;
    const b = faulty.result as FixtureResult;
    expect(b, faulty.stderr).toBeDefined();
    for (const s of scenarios) {
      expect(b.responses[s]?.status, s).toBe(200);
      expect(stripIds(b.responses[s]?.body), s).toEqual(
        stripIds(a.responses[s]?.body),
      );
    }
    expect(b.failures["http.created"]).toBeGreaterThan(0);
    if (dbs.pg) expect(b.failures["pg.client.query"]).toBeGreaterThan(0);
    // With creation failing, node:http sends no traceparent of ours (fetch is upstream's;
    // /user-traceparent carries the caller's own header).
    const ours = b.received.filter(
      (r) => !["/fetch", "/user-traceparent"].includes(r.path),
    );
    expect(ours.length).toBeGreaterThan(5);
    expect(ours.every((r) => r.traceparent === undefined)).toBe(true);
  });

  it("DEMONSTRATION: an unguarded subscriber that throws raises uncaughtException (the request itself completes)", async () => {
    const out = await runNode<{ httpStatus: number; seen: string[] }>(
      join(spikeRoot, "scripts/unguarded-subscriber.mjs"),
      {
        marker: "__UNGUARDED__",
        args: ["handled"],
        env: { REDIS_URL: undefined },
      },
    );
    expect(out.result?.httpStatus).toBe(200);
    expect(out.result?.seen).toEqual([
      "uncaughtException: unguarded http.client.request.created subscriber",
    ]);
  });

  it("DEMONSTRATION: with no uncaughtException handler (a default app), the process dies", async () => {
    const out = await runNode(
      join(spikeRoot, "scripts/unguarded-subscriber.mjs"),
      {
        marker: "__UNGUARDED__",
        args: ["unhandled"],
        env: { REDIS_URL: undefined },
      },
    );
    expect(out.result).toBeUndefined();
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(
      "unguarded http.client.request.created subscriber",
    );
  });
});

describe("Finding: @opentelemetry/api dual package in a CommonJS app", () => {
  interface Dual {
    earlyRecording: boolean;
    earlySpanId: string;
    lateRecording: boolean;
    exported: string[];
  }

  it("a tracer taken from the CJS build before the ESM-only library registers its provider stays a no-op", async () => {
    const out = await runNode<Dual>(join(spikeRoot, "scripts/dual-api.cjs"), {
      marker: "__DUAL_API__",
    });
    expect(out.result).toEqual({
      node: process.version,
      earlyRecording: false,
      earlySpanId: "0000000000000000",
      lateRecording: true,
      exported: ["late"],
    });
  });

  it("control: the same sequence in an ESM app records both spans", async () => {
    const out = await runNode<Dual>(join(spikeRoot, "scripts/dual-api.mjs"), {
      marker: "__DUAL_API__",
    });
    expect(out.result?.earlyRecording).toBe(true);
    expect(out.result?.exported).toEqual(["early", "late"]);
  });

  it.each([
    ["same", true],
    ["esm", false],
  ])(
    "F5 control: early CJS tracer, provider registered through the %s instance: delegates = %s",
    async (mode, delegates) => {
      const out = await runNode<{
        registered: boolean;
        earlyDelegates: boolean;
        lateDelegates: boolean;
      }>(join(spikeRoot, "scripts/dual-control.cjs"), {
        marker: "__DUAL_CONTROL__",
        args: [mode as string],
      });
      expect(out.result).toEqual({
        mode,
        registered: true,
        earlyDelegates: delegates,
        lateDelegates: true,
      });
    },
  );
});
