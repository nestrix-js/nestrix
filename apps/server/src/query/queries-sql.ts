/**
 * The SQL of `GET api/v1/queries` (P9-03): database and cache client spans grouped by sanitised
 * statement and system over a `start_time` window. Pure: returns text and parameters, so a unit
 * test can check it without a database. Only whitelisted names reach the text; values are
 * parameters.
 */
import type { QuerySort } from "@nestrix-js/protocol";

/** A statement that ran this many times in one trace is an N+1 candidate. */
export const REPEAT_THRESHOLD = 3;
/** Example trace ids per statement. */
export const MAX_EXAMPLES = 3;

const ORDER: Record<QuerySort, string> = {
  total: "total_ns",
  count: "n",
  p95: "p95_ns",
  max: "max_ns",
};

export interface QueriesSql {
  text: string;
  values: unknown[];
}

export function queriesSql(opts: {
  from: Date;
  to: Date;
  service: string | undefined;
  sort: QuerySort;
  limit: number;
}): QueriesSql {
  const values: unknown[] = [opts.from, opts.to];
  const where = [
    "s.kind = 'client'",
    "s.start_time >= $1",
    "s.start_time <= $2",
    "s.attributes->>'db.query.text' IS NOT NULL",
    "COALESCE(s.attributes->>'db.system.name', s.attributes->>'db.system') IS NOT NULL",
  ];
  if (opts.service !== undefined) {
    values.push(opts.service);
    where.push(`s.service_name = $${values.length}`);
  }
  values.push(opts.limit);
  const limit = `$${values.length}`;
  const text = `WITH q AS (
  SELECT s.trace_id, s.attributes->>'db.query.text' AS stmt,
         COALESCE(s.attributes->>'db.system.name', s.attributes->>'db.system') AS sys,
         s.duration_ns, s.status_code
    FROM spans s
   WHERE ${where.join(" AND ")}
),
agg AS (
  SELECT stmt, sys, count(*)::int AS n, sum(duration_ns)::float8 AS total_ns,
         max(duration_ns)::float8 AS max_ns,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ns)::float8 AS p95_ns,
         count(*) FILTER (WHERE status_code = 'error')::int AS errors
    FROM q GROUP BY stmt, sys
),
per_trace AS (
  SELECT stmt, sys, trace_id, count(*) AS c, max(duration_ns) AS mx
    FROM q GROUP BY stmt, sys, trace_id
),
tr AS (
  SELECT stmt, sys, count(*)::int AS traces,
         count(*) FILTER (WHERE c >= ${REPEAT_THRESHOLD})::int AS repeated,
         (array_agg(trace_id ORDER BY mx DESC, trace_id))[1:${MAX_EXAMPLES}] AS examples
    FROM per_trace GROUP BY stmt, sys
)
SELECT agg.stmt, agg.sys, agg.n, agg.total_ns, agg.max_ns, agg.p95_ns, agg.errors,
       tr.traces, tr.repeated, tr.examples
  FROM agg JOIN tr ON tr.stmt = agg.stmt AND tr.sys = agg.sys
 ORDER BY agg.${ORDER[opts.sort]} DESC, agg.stmt, agg.sys
 LIMIT ${limit}`;
  return { text, values };
}
