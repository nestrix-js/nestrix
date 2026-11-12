/**
 * The queries page (P9-03): database and cache client spans grouped by sanitised statement and
 * system, across the stored traces of a window. Built from sampled traces, so it reflects
 * sampling. Pure apart from reading the store; never throws; bounded in memory.
 */
import type {
  QuerySort,
  QueryStatement,
  QueryStatsResponse,
  SpanRecord,
} from "./protocol-types.js";
import type { TraceStore } from "./store.js";

/** Distinct statements tracked; further new ones are skipped and the response says so. */
export const MAX_STATEMENTS = 1000;
/** Durations kept per statement for the p95; past it the percentile covers the first ones. */
export const MAX_DURATION_SAMPLES = 2000;
/** A statement that ran this many times in one trace is an N+1 candidate. */
export const REPEAT_THRESHOLD = 3;
const MAX_EXAMPLES = 3;
const CACHE_SYSTEMS = new Set(["redis", "valkey", "memcached"]);

interface Acc {
  statement: string;
  system: string;
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
  traces: number;
  repeatedTraces: number;
  durations: number[];
  /** Slowest first, one entry per trace. */
  examples: { traceId: string; ms: number }[];
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The statement and system of a database or cache client span, or `undefined`. */
export function statementOf(
  span: SpanRecord,
): { statement: string; system: string } | undefined {
  if (span.kind !== "client") return undefined;
  const statement = text(span.attributes["db.query.text"]);
  if (statement === undefined) return undefined;
  const system =
    text(span.attributes["db.system.name"]) ??
    text(span.attributes["db.system"]);
  if (system === undefined) return undefined;
  return { statement, system };
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

const SORT_KEY: Record<QuerySort, (q: QueryStatement) => number> = {
  total: (q) => q.totalMs,
  count: (q) => q.count,
  p95: (q) => q.p95Ms,
  max: (q) => q.maxMs,
};

export function buildQueryStats(
  store: TraceStore | undefined,
  windowMinutes: number,
  now: number,
  sort: QuerySort = "total",
  limit = 50,
): QueryStatsResponse {
  const from = now - windowMinutes * 60_000;
  const all = new Map<string, Acc>();
  let truncated = false;
  try {
    store?.scanTraces(from, (root, spans, _resource, traceId) => {
      if (root.startTimeUnixMs > now) return;
      const inTrace = new Map<string, { acc: Acc; n: number; maxMs: number }>();
      for (const span of spans) {
        const s = statementOf(span);
        if (s === undefined) continue;
        const key = `${s.system}\u0000${s.statement}`;
        let acc = all.get(key);
        if (acc === undefined) {
          if (all.size >= MAX_STATEMENTS) {
            truncated = true;
            continue;
          }
          acc = {
            statement: s.statement,
            system: s.system,
            count: 0,
            totalMs: 0,
            maxMs: 0,
            errors: 0,
            traces: 0,
            repeatedTraces: 0,
            durations: [],
            examples: [],
          };
          all.set(key, acc);
        }
        acc.count++;
        acc.totalMs += span.durationMs;
        if (span.durationMs > acc.maxMs) acc.maxMs = span.durationMs;
        if (span.status.code === "error") acc.errors++;
        if (acc.durations.length < MAX_DURATION_SAMPLES) {
          acc.durations.push(span.durationMs);
        }
        const t = inTrace.get(key);
        if (t === undefined) {
          inTrace.set(key, { acc, n: 1, maxMs: span.durationMs });
        } else {
          t.n++;
          if (span.durationMs > t.maxMs) t.maxMs = span.durationMs;
        }
      }
      for (const { acc, n, maxMs } of inTrace.values()) {
        acc.traces++;
        if (n >= REPEAT_THRESHOLD) acc.repeatedTraces++;
        acc.examples.push({ traceId, ms: maxMs });
        acc.examples.sort((a, b) => b.ms - a.ms);
        if (acc.examples.length > MAX_EXAMPLES)
          acc.examples.length = MAX_EXAMPLES;
      }
    });
  } catch {
    // Answer with what was gathered.
  }
  const queries: QueryStatement[] = [...all.values()].map((a) => ({
    statement: a.statement,
    system: a.system,
    kind: CACHE_SYSTEMS.has(a.system.toLowerCase()) ? "cache" : "database",
    count: a.count,
    totalMs: a.totalMs,
    avgMs: a.count === 0 ? 0 : a.totalMs / a.count,
    p95Ms: quantile(a.durations, 0.95),
    maxMs: a.maxMs,
    errors: a.errors,
    traces: a.traces,
    repeatedTraces: a.repeatedTraces,
    exampleTraceIds: a.examples.map((e) => e.traceId),
  }));
  const key = SORT_KEY[sort];
  queries.sort(
    (a, b) =>
      key(b) - key(a) ||
      (a.statement < b.statement ? -1 : a.statement > b.statement ? 1 : 0),
  );
  return {
    windowMinutes,
    fromUnixMs: from,
    toUnixMs: now,
    sampled: true,
    truncated,
    queries: queries.slice(0, limit),
  };
}
