/**
 * Queries API (`GET api/v1/queries`, docs/backlog/phase-9.md P9-03): database and cache
 * statements aggregated across the stored traces of a window. Types only.
 */

/** One statement (the sanitised `db.query.text`) on one database system. */
export interface QueryStatement {
  /** The sanitised statement text (`db.query.text`). */
  statement: string;
  /** `db.system.name`, or `db.system`. */
  system: string;
  /** `cache` for redis, valkey and memcached; `database` otherwise. */
  kind: "database" | "cache";
  count: number;
  totalMs: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  errors: number;
  /** Traces in which the statement ran at least once. */
  traces: number;
  /** Traces in which it ran 3 or more times: N+1 candidates. */
  repeatedTraces: number;
  /** Up to 3 trace ids, the traces holding the slowest executions first. */
  exampleTraceIds: string[];
}

export type QuerySort = "total" | "count" | "p95" | "max";

/** Always built from the stored, sampled traces (never counted before sampling). */
export interface QueryStatsResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  /** Always `true`: the numbers reflect sampling. */
  sampled: true;
  /** True when the embedded scan stopped early (statement cap) so some statements are missing. */
  truncated: boolean;
  queries: QueryStatement[];
}
