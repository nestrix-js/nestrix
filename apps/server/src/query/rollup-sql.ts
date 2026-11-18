/**
 * Reads of the minute rollups (`route_minutes`, `class_minutes`) summed in SQL (issue #29, D-107).
 *
 * A 30 day range holds 43,200 minute rows per route and service: shipping them to the process to
 * add up there is the cost of a long range, so the rows are summed per bucket (and route) by
 * PostgreSQL and only those sums come back. The latency histogram is summed with one `sum(hist[i])`
 * per bucket, which is an order of magnitude cheaper than unnesting every row's array (measured
 * in D-107). Every view that reads the rollups goes through here.
 */
import type pg from "pg";
import { HISTOGRAM_BUCKETS } from "../storage/histogram.js";
import { type Scope, scopeSql } from "./scope.js";

/** `sum(hist[1]) AS h0, ...`: the histogram summed element by element. */
const HIST_SUMS = Array.from(
  { length: HISTOGRAM_BUCKETS },
  (_, i) => `sum(hist[${i + 1}])::float8 AS h${i}`,
).join(", ");

export interface RouteRollupRow {
  /** Start of the bucket, Unix ms. */
  bucketMs: number;
  method: string;
  route: string;
  count: number;
  errors: number;
  maxMs: number;
  hist: number[];
}

export interface RouteRollupQuery {
  /** Minutes with `fromMs <= minute <= toMs` are summed. */
  fromMs: number;
  toMs: number;
  /**
   * Width of a bucket in ms, counted from `originMs`; `0` puts the whole range in one bucket
   * (`bucketMs` of every row is then `fromMs`).
   */
  bucketMs: number;
  originMs?: number;
  /** Service and environment (issue #28, D-101); absent is every one. */
  scope?: Scope | undefined;
  method?: string | undefined;
  route?: string | undefined;
}

/** Placeholders for one statement. */
class Params {
  readonly values: unknown[] = [];
  /** An arrow function, so `params.add` can be passed on (`scopeSql`). */
  readonly add = (value: unknown): string => {
    this.values.push(value);
    return `$${this.values.length}`;
  };
}

/** Sums of `route_minutes` per (bucket, method, route). */
export async function routeRollups(
  db: pg.Pool | pg.PoolClient,
  q: RouteRollupQuery,
): Promise<RouteRollupRow[]> {
  const p = new Params();
  const where = [
    `minute >= ${p.add(new Date(q.fromMs))}`,
    `minute <= ${p.add(new Date(q.toMs))}`,
  ];
  if (q.scope !== undefined) where.push(...scopeSql(q.scope, p.add));
  if (q.method !== undefined) where.push(`method = ${p.add(q.method)}`);
  if (q.route !== undefined) where.push(`route = ${p.add(q.route)}`);
  const bucket =
    q.bucketMs > 0
      ? `(${p.add(q.originMs ?? 0)}::bigint + floor((extract(epoch FROM minute) * 1000 - ${p.add(q.originMs ?? 0)}::bigint) / ${p.add(q.bucketMs)}::bigint) * ${p.add(q.bucketMs)}::bigint)`
      : `${p.add(q.fromMs)}::bigint`;
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${bucket} AS b, method, route, sum(count)::float8 AS count, sum(errors)::float8 AS errors,
            max(max_ms) AS max_ms, ${HIST_SUMS}
       FROM route_minutes WHERE ${where.join(" AND ")}
      GROUP BY 1, 2, 3`,
    p.values,
  );
  return rows.map((r) => {
    const hist: number[] = new Array(HISTOGRAM_BUCKETS);
    for (let i = 0; i < HISTOGRAM_BUCKETS; i++) hist[i] = Number(r[`h${i}`]);
    return {
      bucketMs: Number(r.b),
      method: String(r.method),
      route: String(r.route),
      count: Number(r.count),
      errors: Number(r.errors),
      maxMs: Number(r.max_ms),
      hist,
    };
  });
}

export interface ClassRollupRow {
  className: string;
  methodName: string;
  classKind: string;
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

/** Sums of `class_minutes` per (class, method, kind) over `fromMs <= minute <= toMs`. */
export async function classRollups(
  db: pg.Pool | pg.PoolClient,
  q: { fromMs: number; toMs: number; scope?: Scope | undefined },
): Promise<ClassRollupRow[]> {
  const p = new Params();
  const where = [
    `minute >= ${p.add(new Date(q.fromMs))}`,
    `minute <= ${p.add(new Date(q.toMs))}`,
  ];
  if (q.scope !== undefined) where.push(...scopeSql(q.scope, p.add));
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT class_name, method_name, class_kind, sum(count)::float8 AS count,
            sum(errors)::float8 AS errors, sum(total_ms) AS total_ms, max(max_ms) AS max_ms
       FROM class_minutes WHERE ${where.join(" AND ")}
      GROUP BY 1, 2, 3`,
    p.values,
  );
  return rows.map((r) => ({
    className: String(r.class_name),
    methodName: String(r.method_name),
    classKind: String(r.class_kind),
    count: Number(r.count),
    errors: Number(r.errors),
    totalMs: Number(r.total_ms),
    maxMs: Number(r.max_ms),
  }));
}
