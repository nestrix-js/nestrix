// The queries page (P9-03): synthetic spans through the store, then `buildQueryStats`.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoreProcessor } from "../src/store/processor.js";
import {
  buildQueryStats,
  MAX_STATEMENTS,
  statementOf,
} from "../src/store/queries.js";
import {
  getOrCreateStore,
  resetStoreForTests,
  type TraceStore,
} from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot, traceId } from "./store-helpers.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const CLIENT = 2;
const ERROR = 2;

let store: TraceStore;
let ingest: (...spans: ReadableSpan[]) => void;
let trace = 0;

beforeEach(() => {
  resetStoreForTests();
  store = getOrCreateStore({}, recordingDiagnostics());
  store.attach({});
  const processor = createStoreProcessor(store);
  ingest = (...spans) => {
    for (const s of spans) processor.onEnd(s);
    store.drainNow();
  };
  trace = 0;
});
afterEach(() => {
  resetStoreForTests();
});

interface Call {
  sql?: string;
  system?: string;
  ms: number;
  error?: boolean;
}

/** One trace: a server root plus the given database calls. Returns its trace id. */
function request(calls: Call[], rootStartMs = NOW - MIN): string {
  trace++;
  const root = serverRoot(trace, { startMs: rootStartMs, durationMs: 500 });
  ingest(
    root,
    ...calls.map((c) =>
      fakeSpan({
        trace,
        parent: { spanId: root.spanContext().spanId },
        kind: CLIENT,
        startMs: rootStartMs + 1,
        durationMs: c.ms,
        attributes: {
          ...(c.sql === undefined ? {} : { "db.query.text": c.sql }),
          ...(c.system === undefined
            ? { "db.system.name": "postgresql" }
            : { "db.system.name": c.system }),
        },
        status: { code: c.error ? ERROR : 0 },
      }),
    ),
  );
  return traceId(trace);
}

const SEL = "SELECT * FROM users WHERE id = ?";
const q = (r = buildQueryStats(store, 15, NOW)) => r.queries;

describe("buildQueryStats", () => {
  it("aggregates per statement and system, and marks the response as sampled", () => {
    request([{ sql: SEL, ms: 10 }]);
    request([
      { sql: SEL, ms: 30, error: true },
      { sql: "GET user:?", system: "redis", ms: 1 },
    ]);
    const r = buildQueryStats(store, 15, NOW);
    expect(r.sampled).toBe(true);
    expect(r.truncated).toBe(false);
    const sel = r.queries.find((x) => x.statement === SEL);
    expect(sel).toMatchObject({
      system: "postgresql",
      kind: "database",
      count: 2,
      totalMs: 40,
      avgMs: 20,
      maxMs: 30,
      errors: 1,
      traces: 2,
      repeatedTraces: 0,
    });
    expect(sel?.p95Ms).toBe(30);
    expect(r.queries.find((x) => x.system === "redis")?.kind).toBe("cache");
  });

  it("keeps the same text on two systems apart", () => {
    request([
      { sql: "SELECT 1", ms: 1 },
      { sql: "SELECT 1", system: "mysql", ms: 1 },
    ]);
    expect(q()).toHaveLength(2);
  });

  it("counts traces where a statement ran 3 or more times (N+1 candidates)", () => {
    request([
      { sql: SEL, ms: 1 },
      { sql: SEL, ms: 1 },
    ]);
    request(Array.from({ length: 3 }, () => ({ sql: SEL, ms: 1 })));
    request(Array.from({ length: 5 }, () => ({ sql: SEL, ms: 1 })));
    expect(q()[0]).toMatchObject({ count: 10, traces: 3, repeatedTraces: 2 });
  });

  it("gives up to 3 example trace ids, slowest first", () => {
    const ids = [5, 50, 20, 40, 1].map((ms) => request([{ sql: SEL, ms }]));
    expect(q()[0]?.exampleTraceIds).toEqual([ids[1], ids[3], ids[2]]);
  });

  it("sorts by total, count, p95 or max, and applies the limit", () => {
    request([
      { sql: "many", ms: 1 },
      { sql: "many", ms: 1 },
      { sql: "many", ms: 1 },
      { sql: "slow", ms: 100 },
      { sql: "mid", ms: 10 },
      { sql: "mid", ms: 10 },
    ]);
    const first = (sort: "total" | "count" | "p95" | "max") =>
      buildQueryStats(store, 15, NOW, sort).queries[0]?.statement;
    expect(first("total")).toBe("slow");
    expect(first("count")).toBe("many");
    expect(first("p95")).toBe("slow");
    expect(first("max")).toBe("slow");
    expect(buildQueryStats(store, 15, NOW, "count", 2).queries).toHaveLength(2);
    expect(
      buildQueryStats(store, 15, NOW, "count").queries.map((x) => x.statement),
    ).toEqual(["many", "mid", "slow"]);
  });

  it("ignores spans without a statement or system, non-client spans, and traces outside the window", () => {
    request([{ ms: 5 }]);
    request([{ sql: SEL, ms: 5 }], NOW - 20 * MIN);
    expect(q()).toEqual([]);
    expect(q(buildQueryStats(store, 60, NOW))).toHaveLength(1);
    expect(
      statementOf(
        fakeSpan({
          trace: 1,
          kind: 0,
          attributes: { "db.query.text": "x" },
        }) as never,
      ),
    ).toBeUndefined();
  });

  it("reads db.system when db.system.name is absent", () => {
    trace++;
    const root = serverRoot(trace, { startMs: NOW - MIN });
    ingest(
      root,
      fakeSpan({
        trace,
        parent: { spanId: root.spanContext().spanId },
        kind: CLIENT,
        startMs: NOW - MIN,
        attributes: { "db.query.text": "GET k", "db.system": "redis" },
      }),
    );
    expect(q()[0]).toMatchObject({ system: "redis", kind: "cache" });
  });

  it("is empty without a store", () => {
    expect(buildQueryStats(undefined, 15, NOW)).toMatchObject({
      sampled: true,
      queries: [],
    });
  });

  it("caps distinct statements and says so", () => {
    for (let i = 0; i < 5; i++) {
      request(
        Array.from({ length: MAX_STATEMENTS / 5 + 1 }, (_, j) => ({
          sql: `SELECT ${i}_${j}`,
          ms: 1,
        })),
      );
    }
    const r = buildQueryStats(store, 15, NOW, "count", 200);
    expect(r.truncated).toBe(true);
    expect(r.queries.length).toBe(200);
  });
});
