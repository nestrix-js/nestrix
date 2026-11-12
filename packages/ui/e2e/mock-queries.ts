// Mock data for the queries page (P9-03).
import type {
  QuerySort,
  QueryStatement,
  QueryStatsResponse,
} from "@nestrix-js/protocol";

export const TRACE_A = "a".repeat(32);
export const TRACE_B = "b".repeat(32);
export const LONG_SQL = `SELECT o.id, o.total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.region = ? AND o.status IN (?, ?, ?) ORDER BY o.created_at DESC LIMIT ?`;

const stmt = (
  statement: string,
  system: string,
  count: number,
  avgMs: number,
  p95Ms: number,
  maxMs: number,
  extra: Partial<QueryStatement> = {},
): QueryStatement => ({
  statement,
  system,
  kind: system === "redis" ? "cache" : "database",
  count,
  totalMs: count * avgMs,
  avgMs,
  p95Ms,
  maxMs,
  errors: 0,
  traces: 1,
  repeatedTraces: 0,
  exampleTraceIds: [TRACE_A],
  ...extra,
});

/** Total: long 1200, user 500, redis 100. Count: redis 500, user 100, long 10. */
export const STATEMENTS: QueryStatement[] = [
  stmt(LONG_SQL, "postgresql", 10, 120, 300, 400, {
    traces: 10,
    exampleTraceIds: [TRACE_B, TRACE_A],
  }),
  stmt("SELECT * FROM users WHERE id = ?", "postgresql", 100, 5, 9, 15, {
    traces: 8,
    repeatedTraces: 6,
    errors: 2,
    exampleTraceIds: [TRACE_A],
  }),
  stmt("GET session:?", "redis", 500, 0.2, 0.5, 2, { traces: 40 }),
];

const KEY: Record<QuerySort, (q: QueryStatement) => number> = {
  total: (q) => q.totalMs,
  count: (q) => q.count,
  p95: (q) => q.p95Ms,
  max: (q) => q.maxMs,
};

export function generatedQueries(
  windowMinutes: number,
  sort: QuerySort = "total",
  statements: QueryStatement[] = STATEMENTS,
): QueryStatsResponse {
  const now = Date.now();
  return {
    windowMinutes,
    fromUnixMs: now - windowMinutes * 60_000,
    toUnixMs: now,
    sampled: true,
    truncated: false,
    queries: statements.slice().sort((a, b) => KEY[sort](b) - KEY[sort](a)),
  };
}
