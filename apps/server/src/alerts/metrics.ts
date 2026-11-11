/**
 * Metric values of alert rules, computed from the route rollups (`route_minutes`).
 *
 * The window is the rule's last `windowMinutes` minute buckets, the current (partial) minute
 * included: `minute > now - windowMinutes` minutes, `minute <= now`. Errors are the rollup's
 * (status error or 5xx). A rule with `route` reads that route under every method.
 *
 * Each metric returns `null` ("no data") when the window holds fewer than `minRequests`
 * requests, so one failed request out of two does not page anyone.
 *
 * `METRICS` is the registry the evaluator calls; a new rule kind adds an entry here and a value
 * to the `metric` check in a migration (`slo_burn_rate` did, in 0003_slos.sql).
 */
import type { Pool, PoolClient } from "pg";
import { badFraction, type SloRow } from "../slos/compute.js";
import { estimateQuantile, HISTOGRAM_BUCKETS } from "../storage/histogram.js";

export interface MetricRule {
  serviceName: string;
  route: string | null;
  windowMinutes: number;
  minRequests: number;
  /** The SLO of a `slo_burn_rate` rule. */
  sloId?: number | null;
}

export interface WindowTotals {
  count: number;
  errors: number;
  maxMs: number;
  hist: number[];
}

export type MetricFn = (
  db: Pool | PoolClient,
  rule: MetricRule,
  nowMs: number,
) => Promise<number | null>;

/** Sums of `route_minutes` over the rule's window (one query; histogram summed in SQL). */
export function windowTotals(
  db: Pool | PoolClient,
  rule: MetricRule,
  nowMs: number,
): Promise<WindowTotals> {
  return rangeTotals(
    db,
    rule.serviceName,
    rule.route,
    nowMs - rule.windowMinutes * 60_000,
    nowMs,
  );
}

/** Sums of `route_minutes` with `fromMs < minute <= toMs` for a service (and a route, any method). */
export async function rangeTotals(
  db: Pool | PoolClient,
  serviceName: string,
  route: string | null,
  fromMs: number,
  toMs: number,
): Promise<WindowTotals> {
  const params: unknown[] = [serviceName, new Date(fromMs), new Date(toMs)];
  let routeClause = "";
  if (route !== null) {
    params.push(route);
    routeClause = "AND route = $4";
  }
  const { rows } = await db.query<{
    count: string | null;
    errors: string | null;
    max_ms: number | null;
    hist: string[] | null;
  }>(
    `WITH w AS (
       SELECT count, errors, max_ms, hist FROM route_minutes
        WHERE service_name = $1 AND minute > $2 AND minute <= $3 ${routeClause}
     )
     SELECT (SELECT sum(count) FROM w)::bigint AS count,
            (SELECT sum(errors) FROM w)::bigint AS errors,
            (SELECT max(max_ms) FROM w) AS max_ms,
            (SELECT array_agg(s ORDER BY i) FROM (
               SELECT u.i, sum(u.h)::bigint AS s
                 FROM w, unnest(w.hist) WITH ORDINALITY AS u(h, i)
                GROUP BY u.i) b) AS hist`,
    params,
  );
  const row = rows[0];
  const hist = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  (row?.hist ?? []).forEach((v, i) => {
    if (i < HISTOGRAM_BUCKETS) hist[i] = Number(v);
  });
  return {
    count: Number(row?.count ?? 0),
    errors: Number(row?.errors ?? 0),
    maxMs: Number(row?.max_ms ?? 0),
    hist,
  };
}

export const METRICS: Record<
  "error_rate" | "p95_ms" | "slo_burn_rate",
  MetricFn
> = {
  async error_rate(db, rule, nowMs) {
    const t = await windowTotals(db, rule, nowMs);
    if (t.count < rule.minRequests || t.count === 0) return null;
    return t.errors / t.count;
  },
  async p95_ms(db, rule, nowMs) {
    const t = await windowTotals(db, rule, nowMs);
    if (t.count < rule.minRequests || t.count === 0) return null;
    return estimateQuantile(t.hist, t.count, 0.95, t.maxMs);
  } /**
   * Burn rate of the rule's SLO over the rule's window: bad fraction / (1 - objective). The SLO is
   * read at each evaluation, so editing it takes effect at once; a deleted SLO deletes its rules.
   */,
  async slo_burn_rate(db, rule, nowMs) {
    if (rule.sloId === null || rule.sloId === undefined) return null;
    const { rows } = await db.query<SloRow>(
      "SELECT * FROM slos WHERE id = $1",
      [rule.sloId],
    );
    const slo = rows[0];
    if (slo === undefined) return null;
    const t = await rangeTotals(
      db,
      slo.service_name,
      slo.route,
      nowMs - rule.windowMinutes * 60_000,
      nowMs,
    );
    if (t.count < rule.minRequests || t.count === 0) return null;
    return badFraction(slo, t) / (1 - slo.objective);
  },
};
