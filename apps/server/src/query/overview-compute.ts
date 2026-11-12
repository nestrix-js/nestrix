/**
 * The Overview computation (phase 11, P11-01): totals, series, Apdex, status mix, time by kind,
 * insights ("needs attention" / "getting better") and the health score, from plain inputs.
 *
 * Pure: no store, no database, no clock. Each backend gathers the inputs from its own query code
 * and calls {@link computeOverview}. `apps/server/src/query/overview-compute.ts` is a byte-identical
 * copy for the standalone server (the server cannot import this package's internals, the same
 * arrangement as `store/error-groups.ts`); `apps/server/test/query/overview-compute-copy.test.ts`
 * fails when the two differ. Edit this file, then copy it over the other.
 *
 * The only import is types from `@nestrix-js/protocol` (private; erased at build), so the copy
 * compiles unchanged on both sides. Nothing here throws on well-formed input.
 */
import type {
  DependencyStats,
  ErrorGroup,
  Insight,
  InsightLink,
  InsightSeverity,
  OverviewHealth,
  OverviewRelease,
  OverviewResponse,
  OverviewSeriesPoint,
  OverviewStatusMix,
  OverviewTimeShare,
  OverviewTotals,
} from "@nestrix-js/protocol";

export const MINUTE_MS = 60_000;
/** The most points a series has. */
export const MAX_SERIES_POINTS = 30;
/** The most insights in each list. */
export const MAX_INSIGHTS = 6;

// ---- thresholds (docs/backlog/phase-11.md, "Insight rules") ---------------------------------

/** Routes need this many requests in each compared window. */
export const MIN_ROUTE_REQUESTS = 20;
/** Dependencies need this many sampled calls in each compared window (not in the backlog: guards against one-call noise). */
export const MIN_DEPENDENCY_CALLS = 10;
/** A cleared error group needs this many events in the previous window (not in the backlog). */
export const MIN_CLEARED_EVENTS = 3;

// ---- inputs ----------------------------------------------------------------------------------

/** One minute of one route (the rows of the route statistics, or of `route_minutes`). */
export interface MinuteRow {
  /** Minute index: Unix ms / 60 000. */
  minute: number;
  method: string;
  route: string;
  count: number;
  errors: number;
  /** Largest duration in the row, ms. */
  max: number;
  /** The 30-bucket latency histogram (bounds in {@link HISTOGRAM_UPPER_BOUNDS_MS}). */
  hist: ArrayLike<number>;
}

/** What decides the kind a span's time is counted under. */
export interface SpanFacts {
  /** Span kind: `server`, `client`, `internal`, `producer` or `consumer`. */
  kind: string;
  /** Lower-cased `db.system.name` or `db.system`; `undefined` when neither is set. */
  dbSystem: string | undefined;
  /** `messaging.system` is set. */
  messaging: boolean;
  /** `http.request.method`, `http.method` or `url.full` is set. */
  http: boolean;
  /** A Nest handler, method or enhancer span (`nestrix.class` or `nestrix.component`). */
  nest: boolean;
}

/** Own time (duration minus the children's) of the spans that share `facts`, ms. */
export interface KindRow {
  facts: SpanFacts;
  ms: number;
}

/** An SLO whose budget is burning (standalone server only). */
export interface SloBurnInput {
  id: string;
  name: string;
  /** Burn rate over the last hour; `null` without requests. */
  burnRate1h: number | null;
  /** Bad requests in the SLO's window. */
  badRequests: number;
}

export interface OverviewInput {
  nowUnixMs: number;
  /** 15 or 60. */
  windowMinutes: number;
  apdexMs: number;
  /** Whether statistics are kept for the whole previous window, and why not. */
  previousCovered: boolean;
  note: string | null;
  /** Route-minute rows for the previous and the current window (the previous rows are ignored when not covered). */
  rows: readonly MinuteRow[];
  /** From the sampled traces of the current window. */
  status: OverviewStatusMix;
  kinds: readonly KindRow[];
  /** `null` when the previous window has no traces to compare with. */
  previousKinds: readonly KindRow[] | null;
  releases: readonly OverviewRelease[];
  errorGroups: {
    current: readonly ErrorGroup[];
    previous: readonly ErrorGroup[];
  };
  dependencies: {
    current: readonly DependencyStats[];
    previous: readonly DependencyStats[];
  };
  /** Absent on the embedded dashboard. */
  slos?: readonly SloBurnInput[];
}

// ---- latency histogram (the same bounds as route statistics and the rollup tables) -----------

const HIST_MIN_MS = 1;
const HIST_MAX_MS = 60_000;
const HIST_STEPS = 28;
export const HISTOGRAM_BUCKETS = HIST_STEPS + 2;
const LN_STEP = Math.log(HIST_MAX_MS / HIST_MIN_MS) / HIST_STEPS;

/** Upper bound of bucket i in ms for i in 0..28; bucket 29 has none. */
export const HISTOGRAM_UPPER_BOUNDS_MS: readonly number[] = Array.from(
  { length: HIST_STEPS + 1 },
  (_, i) =>
    i === HIST_STEPS ? HIST_MAX_MS : HIST_MIN_MS * Math.exp(i * LN_STEP),
);

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The `q` quantile of a histogram of `total` values, interpolated inside its bucket, at most `max`. */
export function quantileOf(
  hist: ArrayLike<number>,
  total: number,
  q: number,
  max: number,
): number {
  if (total <= 0) return 0;
  const rank = Math.max(1, Math.ceil(q * total));
  let cumulative = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    const n = hist[i] ?? 0;
    if (n === 0) continue;
    if (cumulative + n >= rank) {
      const lo = i === 0 ? 0 : (HISTOGRAM_UPPER_BOUNDS_MS[i - 1] as number);
      const hi =
        i === HISTOGRAM_BUCKETS - 1
          ? max
          : (HISTOGRAM_UPPER_BOUNDS_MS[i] as number);
      const value = lo + ((rank - cumulative) / n) * Math.max(0, hi - lo);
      return round3(Math.min(value, max));
    }
    cumulative += n;
  }
  return round3(max);
}

interface Acc {
  count: number;
  errors: number;
  max: number;
  hist: number[];
}

const newAcc = (): Acc => ({
  count: 0,
  errors: 0,
  max: 0,
  hist: new Array<number>(HISTOGRAM_BUCKETS).fill(0),
});

function addRow(acc: Acc, row: MinuteRow): void {
  acc.count += row.count;
  acc.errors += row.errors;
  if (row.max > acc.max) acc.max = row.max;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    acc.hist[i] = (acc.hist[i] as number) + (row.hist[i] ?? 0);
  }
}

const pctile = (acc: Acc, q: number) =>
  quantileOf(acc.hist, acc.count, q, acc.max);

/**
 * Apdex from a histogram. A bucket counts as satisfied when its upper edge is at most T, as
 * tolerating when it is at most 4T (so a request is judged by its bucket's upper edge: an
 * approximation, at most one bucket, about 48%, pessimistic). The overflow bucket (> 60 s) is
 * frustrated. Errors are frustrated whatever their duration; their durations are not in the
 * histogram, so they are taken out of the satisfied and tolerating counts in proportion.
 */
export function apdexOf(
  hist: ArrayLike<number>,
  count: number,
  errors: number,
  apdexMs: number,
): { satisfied: number; tolerating: number; frustrated: number } {
  let sat = 0;
  let tol = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    const edge =
      i === HISTOGRAM_BUCKETS - 1
        ? Number.POSITIVE_INFINITY
        : (HISTOGRAM_UPPER_BOUNDS_MS[i] as number);
    const n = hist[i] ?? 0;
    if (edge <= apdexMs) sat += n;
    else if (edge <= 4 * apdexMs) tol += n;
  }
  const failed = count === 0 ? 0 : Math.min(1, errors / count);
  const satisfied = Math.round(sat * (1 - failed));
  const tolerating = Math.round(tol * (1 - failed));
  return {
    satisfied,
    tolerating,
    frustrated: Math.max(0, count - satisfied - tolerating),
  };
}

function totalsOf(
  acc: Acc,
  windowMinutes: number,
  apdexMs: number,
): OverviewTotals {
  const a = apdexOf(acc.hist, acc.count, acc.errors, apdexMs);
  return {
    count: acc.count,
    errors: acc.errors,
    errorRate: acc.count === 0 ? 0 : acc.errors / acc.count,
    p50Ms: pctile(acc, 0.5),
    p95Ms: pctile(acc, 0.95),
    p99Ms: pctile(acc, 0.99),
    perMinute: acc.count / windowMinutes,
    apdex:
      acc.count === 0 ? null : (a.satisfied + a.tolerating / 2) / acc.count,
    satisfied: a.satisfied,
    tolerating: a.tolerating,
    frustrated: a.frustrated,
  };
}

// ---- time by kind ----------------------------------------------------------------------------

export const TIME_KEYS = [
  "db",
  "http-out",
  "redis",
  "messaging",
  "app",
  "other",
] as const;
export type TimeKey = (typeof TIME_KEYS)[number];

const CACHE_SYSTEMS = new Set(["redis", "valkey", "memcached"]);

/** The kind a span's own time is counted under. */
export function timeKeyOf(f: SpanFacts): TimeKey {
  if (f.dbSystem !== undefined) {
    return CACHE_SYSTEMS.has(f.dbSystem) ? "redis" : "db";
  }
  if (f.messaging || f.kind === "producer" || f.kind === "consumer") {
    return "messaging";
  }
  if (f.kind === "client" && f.http) return "http-out";
  if (f.nest) return "app";
  return "other";
}

function sumKinds(rows: readonly KindRow[]): Record<TimeKey, number> {
  const out: Record<TimeKey, number> = {
    db: 0,
    "http-out": 0,
    redis: 0,
    messaging: 0,
    app: 0,
    other: 0,
  };
  for (const r of rows) {
    if (Number.isFinite(r.ms) && r.ms > 0) out[timeKeyOf(r.facts)] += r.ms;
  }
  return out;
}

function timeByKind(
  current: readonly KindRow[],
  previous: readonly KindRow[] | null,
): OverviewTimeShare[] {
  const cur = sumKinds(current);
  const prev = previous === null ? null : sumKinds(previous);
  const curSum = TIME_KEYS.reduce((s, k) => s + cur[k], 0);
  const prevSum =
    prev === null ? 0 : TIME_KEYS.reduce((s, k) => s + prev[k], 0);
  return TIME_KEYS.map((key) => ({
    key,
    ms: round3(cur[key]),
    share: curSum === 0 ? 0 : cur[key] / curSum,
    previousShare: prev === null || prevSum === 0 ? null : prev[key] / prevSum,
  }));
}

// ---- formatting ------------------------------------------------------------------------------

/** Milliseconds below one second, then seconds with one decimal. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const formatPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;
const formatCount = (n: number): string =>
  Math.round(n).toLocaleString("en-US");
const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;
const describeMethod = (m: string): string => (m === "*" ? "" : `${m} `);

// ---- insights --------------------------------------------------------------------------------

const EPS = 1e-9;

function changeOf(before: number | null, after: number): number | null {
  return before === null || before === 0 ? null : (after - before) / before;
}

/** Requests or events affected × min(|change|, 10); something new (no change) counts × 1. */
function impactOf(affected: number, change: number | null): number {
  return affected * (change === null ? 1 : Math.min(Math.abs(change), 10));
}

/** At most {@link MAX_SERIES_POINTS} values, merging neighbours by `merge`. */
function capSeries(
  values: readonly number[],
  merge: (group: readonly number[]) => number,
): number[] {
  if (values.length <= MAX_SERIES_POINTS) return values.slice();
  const size = Math.ceil(values.length / MAX_SERIES_POINTS);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(merge(values.slice(i, i + size)));
  }
  return out;
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const maxOf = (xs: readonly number[]) => Math.max(...xs);

// ---- the rules, one function each (exported so the boundaries are tested exactly) -------------

export interface Verdict {
  direction: "worse" | "better";
  severity: InsightSeverity;
}

/**
 * Route p95: worse at 1.2x and +50 ms or more (`high` at 1.5x with 100 requests or more, else
 * `medium`); better at 0.8x and -30 ms or less (`low`).
 */
export function latencyVerdict(
  before: number,
  after: number,
  requests: number,
): Verdict | undefined {
  if (!(before > 0)) return undefined;
  if (after >= 1.2 * before - EPS && after - before >= 50 - EPS) {
    const high = after >= 1.5 * before - EPS && requests >= 100;
    return { direction: "worse", severity: high ? "high" : "medium" };
  }
  if (after <= 0.8 * before + EPS && before - after >= 30 - EPS) {
    return { direction: "better", severity: "low" };
  }
  return undefined;
}

/**
 * Route error rate (fractions): worse when up 1 point or more with 5 errors or more now (`high`
 * at 5 points); better when down 1 point or more (`low`).
 */
export function errorRateVerdict(
  rateBefore: number,
  rateAfter: number,
  errorsNow: number,
): Verdict | undefined {
  const up = rateAfter - rateBefore;
  if (up >= 0.01 - EPS && errorsNow >= 5) {
    return {
      direction: "worse",
      severity: up >= 0.05 - EPS ? "high" : "medium",
    };
  }
  if (-up >= 0.01 - EPS) return { direction: "better", severity: "low" };
  return undefined;
}

/** A new error group: 3 events or more (`high` at 50). */
export function newGroupSeverity(events: number): InsightSeverity | undefined {
  if (events < 3) return undefined;
  return events >= 50 ? "high" : "medium";
}

/** An error group spike: 3x the previous window and 10 events or more now (`high` at 10x). */
export function spikeSeverity(
  before: number,
  after: number,
): InsightSeverity | undefined {
  if (after >= 3 * before - EPS && after >= 10) {
    return after >= 10 * before - EPS ? "high" : "medium";
  }
  return undefined;
}

/**
 * Dependency p95: worse at 1.3x and +50 ms or more (`medium`; `high` at 2x); better at 0.75x and
 * -30 ms or less (`low`).
 */
export function dependencyLatencyVerdict(
  before: number,
  after: number,
): Verdict | undefined {
  if (!(before > 0)) return undefined;
  if (after >= 1.3 * before - EPS && after - before >= 50 - EPS) {
    return {
      direction: "worse",
      severity: after >= 2 * before - EPS ? "high" : "medium",
    };
  }
  if (after <= 0.75 * before + EPS && before - after >= 30 - EPS) {
    return { direction: "better", severity: "low" };
  }
  return undefined;
}

/** Dependency error rate: up 2 points or more with 5 errors or more (`medium`; `high` at 10 points). */
export function dependencyErrorSeverity(
  rateBefore: number,
  rateAfter: number,
  errorsNow: number,
): InsightSeverity | undefined {
  const up = rateAfter - rateBefore;
  if (up >= 0.02 - EPS && errorsNow >= 5) {
    return up >= 0.1 - EPS ? "high" : "medium";
  }
  return undefined;
}

/** SLO burn rate over the last hour: above 1 `medium`, above 2 `high`. */
export function sloSeverity(burn: number | null): InsightSeverity | undefined {
  if (burn === null || !(burn > 1)) return undefined;
  return burn > 2 ? "high" : "medium";
}

interface RouteAcc {
  method: string;
  route: string;
  current: Acc;
  previous: Acc;
  rows: MinuteRow[];
}

interface Window {
  curFirst: number;
  last: number;
  prevFirst: number;
  stepMinutes: number;
  buckets: number;
}

function insight(
  fields: Omit<Insight, "change" | "impact"> & { affected: number },
): Insight {
  const { affected, ...rest } = fields;
  const change = changeOf(rest.before, rest.after);
  return { ...rest, change, impact: impactOf(affected, change) };
}

function routeInsights(w: Window, routes: Map<string, RouteAcc>): Insight[] {
  const out: Insight[] = [];
  for (const r of routes.values()) {
    if (
      r.current.count < MIN_ROUTE_REQUESTS ||
      r.previous.count < MIN_ROUTE_REQUESTS
    ) {
      continue;
    }
    const label = `${describeMethod(r.method)}${r.route}`;
    const link = {
      view: "route" as const,
      params: { route: r.route, method: r.method },
    };
    const detail = `${formatCount(r.current.count)} requests in the window`;

    const before = pctile(r.previous, 0.95);
    const after = pctile(r.current, 0.95);
    const latency = latencyVerdict(before, after, r.current.count);
    if (latency !== undefined) {
      out.push(
        insight({
          id: `route-latency:${r.method} ${r.route}`,
          kind: "route-latency",
          direction: latency.direction,
          severity: latency.severity,
          title: `${label} p95 ${formatMs(before)} → ${formatMs(after)}`,
          detail,
          before,
          after,
          unit: "ms",
          affected: r.current.count,
          series: routeSeries(r, w, (a) => pctile(a, 0.95)),
          source: "stats",
          link,
        }),
      );
    }

    const rateBefore = r.previous.errors / r.previous.count;
    const rateAfter = r.current.errors / r.current.count;
    const errors = errorRateVerdict(rateBefore, rateAfter, r.current.errors);
    if (errors !== undefined) {
      out.push(
        insight({
          id: `route-errors:${r.method} ${r.route}`,
          kind: "route-errors",
          direction: errors.direction,
          severity: errors.severity,
          title: `${label} error rate ${formatPct(rateBefore)} → ${formatPct(rateAfter)}`,
          detail,
          before: rateBefore,
          after: rateAfter,
          unit: "ratio",
          affected:
            errors.direction === "worse" ? r.current.errors : r.previous.errors,
          series: routeSeries(r, w, (a) =>
            a.count === 0 ? 0 : a.errors / a.count,
          ),
          source: "stats",
          link,
        }),
      );
    }
  }
  return out;
}

/** The metric of one route per series bucket of the current window. */
function routeSeries(
  r: RouteAcc,
  w: Window,
  metric: (acc: Acc) => number,
): number[] {
  const accs = Array.from({ length: w.buckets }, newAcc);
  for (const row of r.rows) {
    const i = Math.floor((row.minute - w.curFirst) / w.stepMinutes);
    const acc = accs[i];
    if (acc !== undefined) addRow(acc, row);
  }
  return accs.map(metric);
}

const groupKeyOf = (g: ErrorGroup): string =>
  `${g.errorType ?? ""}\u0000${g.pattern}\u0000${g.route ?? ""}`;

function groupName(g: ErrorGroup): string {
  if (g.errorType !== undefined && g.errorType !== "") return g.errorType;
  if (g.pattern !== "") return g.pattern;
  return "An error";
}

function groupDetail(g: ErrorGroup): string {
  const parts: string[] = [];
  if (g.route !== undefined) parts.push(`on ${g.route}`);
  if (g.pattern !== "" && g.errorType !== undefined) parts.push(g.pattern);
  return parts.join(" · ");
}

function errorGroupInsights(
  input: OverviewInput,
  curFromMs: number,
): Insight[] {
  const out: Insight[] = [];
  const previous = new Map(
    input.errorGroups.previous.map((g) => [groupKeyOf(g), g]),
  );
  const current = new Map(
    input.errorGroups.current.map((g) => [groupKeyOf(g), g]),
  );
  const events = (n: number) =>
    `${formatCount(n)} ${plural(n, "event", "events")}`;
  const link = (g: ErrorGroup): InsightLink => ({
    view: "errors",
    params: g.route === undefined ? {} : { route: g.route },
  });

  for (const g of current.values()) {
    const before = previous.get(groupKeyOf(g));
    if (before === undefined) {
      const severity = newGroupSeverity(g.count);
      if (g.firstSeenUnixMs >= curFromMs && severity !== undefined) {
        out.push(
          insight({
            id: `error-group-new:${groupKeyOf(g)}`,
            kind: "error-group-new",
            direction: "worse",
            severity,
            title: `${groupName(g)} is new (${events(g.count)})`,
            detail: groupDetail(g),
            before: null,
            after: g.count,
            unit: "count",
            affected: g.count,
            series: capSeries(g.series, sum),
            source: "traces",
            link: link(g),
          }),
        );
      }
      continue;
    }
    if (!input.previousCovered) continue;
    const spike = spikeSeverity(before.count, g.count);
    if (spike !== undefined) {
      out.push(
        insight({
          id: `error-group-spike:${groupKeyOf(g)}`,
          kind: "error-group-spike",
          direction: "worse",
          severity: spike,
          title: `${groupName(g)} spiked ${formatCount(before.count)} → ${events(g.count)}`,
          detail: groupDetail(g),
          before: before.count,
          after: g.count,
          unit: "count",
          affected: g.count,
          series: capSeries(g.series, sum),
          source: "traces",
          link: link(g),
        }),
      );
    }
  }

  if (input.previousCovered) {
    const halfway = curFromMs + (input.nowUnixMs - curFromMs) / 2;
    for (const [key, before] of previous) {
      if (before.count < MIN_CLEARED_EVENTS) continue;
      const now = current.get(key);
      if (now !== undefined && now.lastSeenUnixMs >= halfway) continue;
      out.push(
        insight({
          id: `error-group-cleared:${key}`,
          kind: "error-group-spike",
          direction: "better",
          severity: "low",
          title: `${groupName(before)} cleared (was ${events(before.count)})`,
          detail: groupDetail(before),
          before: before.count,
          after: now?.count ?? 0,
          unit: "count",
          affected: before.count,
          series: capSeries(now?.series ?? [], sum),
          source: "traces",
          link: link(before),
        }),
      );
    }
  }
  return out;
}

function dependencyInsights(input: OverviewInput): Insight[] {
  const out: Insight[] = [];
  const previous = new Map(input.dependencies.previous.map((d) => [d.id, d]));
  for (const d of input.dependencies.current) {
    const p = previous.get(d.id);
    if (p === undefined) continue;
    if (d.calls < MIN_DEPENDENCY_CALLS || p.calls < MIN_DEPENDENCY_CALLS)
      continue;
    const link = {
      view: "dependencies" as const,
      params: { windowMinutes: String(input.windowMinutes) },
    };
    const detail = `${formatCount(d.calls)} sampled calls in the window`;

    const latency = dependencyLatencyVerdict(p.p95Ms, d.p95Ms);
    if (latency !== undefined) {
      out.push(
        insight({
          id: `dependency-latency:${d.id}`,
          kind: "dependency-latency",
          direction: latency.direction,
          severity: latency.severity,
          title: `${d.name} p95 ${formatMs(p.p95Ms)} → ${formatMs(d.p95Ms)}`,
          detail,
          before: p.p95Ms,
          after: d.p95Ms,
          unit: "ms",
          affected: d.calls,
          series: capSeries(
            d.series.map((s) => s.p95Ms),
            maxOf,
          ),
          source: "traces",
          link,
        }),
      );
    }

    const errorSeverity = dependencyErrorSeverity(
      p.errorRate,
      d.errorRate,
      d.errors,
    );
    if (errorSeverity !== undefined) {
      out.push(
        insight({
          id: `dependency-errors:${d.id}`,
          kind: "dependency-errors",
          direction: "worse",
          severity: errorSeverity,
          title: `${d.name} error rate ${formatPct(p.errorRate)} → ${formatPct(d.errorRate)}`,
          detail,
          before: p.errorRate,
          after: d.errorRate,
          unit: "ratio",
          affected: d.errors,
          // The dependency series carries calls and p95, not errors per bucket.
          series: [],
          source: "traces",
          link,
        }),
      );
    }
  }
  return out;
}

function sloInsights(input: OverviewInput): Insight[] {
  const out: Insight[] = [];
  for (const s of input.slos ?? []) {
    const burn = s.burnRate1h;
    const severity = sloSeverity(burn);
    if (burn === null || severity === undefined) continue;
    out.push(
      insight({
        id: `slo-burn:${s.id}`,
        kind: "slo-burn",
        direction: "worse",
        severity,
        title: `SLO ${s.name} is burning its budget ${burn.toFixed(1)}× too fast`,
        detail: `${formatCount(s.badRequests)} bad requests in the SLO window`,
        before: null,
        after: burn,
        unit: "ratio",
        affected: s.badRequests,
        series: [],
        source: "stats",
        link: { view: "slos", params: {} },
      }),
    );
  }
  return out;
}

const byImpact = (a: Insight, b: Insight): number =>
  b.impact - a.impact || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---- health ----------------------------------------------------------------------------------

/** The health score, level and sentence (backlog "Health"). */
export function healthOf(
  attention: readonly Insight[],
  better: readonly Insight[],
  totals: OverviewTotals,
  windowMinutes: number,
): OverviewHealth {
  let penalty = 0;
  for (const i of attention)
    penalty += i.severity === "high" ? 12 : i.severity === "medium" ? 6 : 0;
  penalty += Math.min(30, totals.errorRate * 1000);
  if (totals.apdex !== null) penalty += (1 - totals.apdex) * 40;
  const score = Math.min(100, Math.max(0, Math.round(100 - penalty)));
  const level = score >= 90 ? "healthy" : score >= 70 ? "degraded" : "critical";

  let summary: string;
  if (attention.length > 0) {
    const n = attention.length;
    const named = attention
      .slice(0, 2)
      .map((i) => i.title)
      .join(", and ");
    summary = `${n} ${plural(n, "thing needs", "things need")} attention: ${named}.`;
  } else if (totals.count === 0) {
    summary = `No requests in the last ${windowMinutes} minutes.`;
  } else {
    summary = "No problems found.";
    if (better.length > 0) {
      summary += ` ${better.length} ${plural(better.length, "thing", "things")} got better.`;
    }
  }
  return { score, level, summary };
}

// ---- the whole answer ------------------------------------------------------------------------

export function computeOverview(input: OverviewInput): OverviewResponse {
  const { windowMinutes, apdexMs, previousCovered } = input;
  const last = Math.floor(input.nowUnixMs / MINUTE_MS);
  const curFirst = last - windowMinutes + 1;
  const prevFirst = curFirst - windowMinutes;
  const stepMinutes = Math.ceil(windowMinutes / MAX_SERIES_POINTS);
  const buckets = Math.ceil(windowMinutes / stepMinutes);
  const w: Window = { curFirst, last, prevFirst, stepMinutes, buckets };

  const current = newAcc();
  const previous = newAcc();
  const curBuckets = Array.from({ length: buckets }, newAcc);
  const prevBuckets = Array.from({ length: buckets }, newAcc);
  const routes = new Map<string, RouteAcc>();

  for (const row of input.rows) {
    const isCurrent = row.minute >= curFirst && row.minute <= last;
    const isPrevious =
      previousCovered && row.minute >= prevFirst && row.minute < curFirst;
    if (!isCurrent && !isPrevious) continue;
    const key = `${row.method}\u0000${row.route}`;
    let r = routes.get(key);
    if (r === undefined) {
      r = {
        method: row.method,
        route: row.route,
        current: newAcc(),
        previous: newAcc(),
        rows: [],
      };
      routes.set(key, r);
    }
    if (isCurrent) {
      addRow(current, row);
      addRow(r.current, row);
      r.rows.push(row);
      const b = curBuckets[Math.floor((row.minute - curFirst) / stepMinutes)];
      if (b !== undefined) addRow(b, row);
    } else {
      addRow(previous, row);
      addRow(r.previous, row);
      const b = prevBuckets[Math.floor((row.minute - prevFirst) / stepMinutes)];
      if (b !== undefined) addRow(b, row);
    }
  }

  const point = (start: number, acc: Acc): OverviewSeriesPoint => {
    const p: OverviewSeriesPoint = {
      timeUnixMs: start * MINUTE_MS,
      count: acc.count,
      errors: acc.errors,
    };
    if (acc.count > 0) {
      p.p50Ms = pctile(acc, 0.5);
      p.p95Ms = pctile(acc, 0.95);
      p.p99Ms = pctile(acc, 0.99);
    }
    return p;
  };

  const insights: Insight[] = [
    ...(previousCovered ? routeInsights(w, routes) : []),
    ...errorGroupInsights(input, curFirst * MINUTE_MS),
    ...(previousCovered ? dependencyInsights(input) : []),
    ...sloInsights(input),
  ];
  const attention = insights
    .filter((i) => i.direction === "worse")
    .sort(byImpact)
    .slice(0, MAX_INSIGHTS);
  const better = insights
    .filter((i) => i.direction === "better")
    .sort(byImpact)
    .slice(0, MAX_INSIGHTS);

  const totals = totalsOf(current, windowMinutes, apdexMs);
  return {
    windowMinutes,
    bucketMs: stepMinutes * MINUTE_MS,
    current: { fromUnixMs: curFirst * MINUTE_MS, toUnixMs: input.nowUnixMs },
    previous: {
      fromUnixMs: prevFirst * MINUTE_MS,
      toUnixMs: curFirst * MINUTE_MS,
    },
    previousCovered,
    note: input.note,
    apdexMs,
    health: healthOf(attention, better, totals, windowMinutes),
    totals,
    previousTotals: previousCovered
      ? totalsOf(previous, windowMinutes, apdexMs)
      : null,
    series: curBuckets.map((acc, i) => point(curFirst + i * stepMinutes, acc)),
    previousSeries: previousCovered
      ? prevBuckets.map((acc, i) => point(prevFirst + i * stepMinutes, acc))
      : [],
    releases: input.releases.map((r) => ({ ...r })),
    status: { ...input.status },
    timeByKind: timeByKind(input.kinds, input.previousKinds),
    attention,
    better,
  };
}
