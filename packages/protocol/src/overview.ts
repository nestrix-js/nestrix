/**
 * The Overview page (phase 11, docs/backlog/phase-11.md): one answer that says how the app is doing
 * now, what got worse and what got better, compared with the previous window of the same length.
 *
 * `GET api/v1/overview?windowMinutes=&service=&apdexMs=` on both backends (embedded dashboard and
 * standalone server). Every figure says where it comes from: `stats` = route statistics counted
 * before sampling; `traces` = built from the stored, sampled traces (D-61).
 */
import type { CompareRange } from "./route-insights.js";

/**
 * `GET <path>/api/v1/overview`. Compares the last `windowMinutes` with the `windowMinutes` before
 * them (the same windows as `routes/compare`). `apdexMs` is the Apdex target T.
 */
export const overviewParams = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  apdexMs: { kind: "int", min: 10, max: 10000, default: 300 },
  service: { kind: "string", maxLength: 256 },
} as const;
export type OverviewParamsSpec = typeof overviewParams;

/** Totals over every route in one window. Counted before sampling (route statistics). */
export interface OverviewTotals {
  count: number;
  /** 5xx or thrown handler (as `RouteStats.errors`). */
  errors: number;
  /** `errors / count`; 0 when `count` is 0. */
  errorRate: number;
  /** Percentiles over every request of every route (merged histograms); 0 when `count` is 0. */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Requests per minute over the window. */
  perMinute: number;
  /** Apdex for `apdexMs`: (satisfied + tolerating / 2) / count; `null` when `count` is 0. */
  apdex: number | null;
  /** Requests at or under `apdexMs`. */
  satisfied: number;
  /** Over `apdexMs`, at or under 4 × `apdexMs`. */
  tolerating: number;
  /** Over 4 × `apdexMs`, plus errors whatever their duration. */
  frustrated: number;
}

/** One bucket of the overall series. Counted before sampling. */
export interface OverviewSeriesPoint {
  timeUnixMs: number;
  count: number;
  errors: number;
  /** Absent when `count` is 0. */
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
}

/** A release first seen inside the window: a deploy marker on the charts. From sampled traces. */
export interface OverviewRelease {
  version: string;
  firstSeenUnixMs: number;
}

/** Responses by status class in the window. From sampled traces (root spans). */
export interface OverviewStatusMix {
  /** 1xx and 2xx, and non-HTTP roots that did not fail. */
  ok: number;
  /** 3xx. */
  redirect: number;
  /** 4xx and not an error. */
  clientError: number;
  /** Root error, or 5xx. */
  serverError: number;
}

/** Share of time in spans by kind. From sampled traces. */
export interface OverviewTimeShare {
  /** `db`, `http-out`, `redis`, `messaging`, `app` (Nest handlers, methods, enhancers), `other`. */
  key: "db" | "http-out" | "redis" | "messaging" | "app" | "other";
  /** Own time of spans of this kind, summed over the window's traces, ms. */
  ms: number;
  /** `ms` over the sum of every key's `ms`, 0 to 1. */
  share: number;
  /** The same share in the previous window; `null` when it has no traces. */
  previousShare: number | null;
}

export type InsightKind =
  | "route-latency"
  | "route-errors"
  | "error-group-new"
  | "error-group-spike"
  | "dependency-latency"
  | "dependency-errors"
  | "slo-burn";

export type InsightSeverity = "high" | "medium" | "low";

/** Where the UI links an insight to. Params are the target view's search params. */
export interface InsightLink {
  view: "route" | "errors" | "dependencies" | "slos";
  params: Record<string, string>;
}

/** One thing that changed between the previous and the current window. */
export interface Insight {
  /** Stable within a response, e.g. `route-latency:POST /orders`. */
  id: string;
  kind: InsightKind;
  direction: "worse" | "better";
  /** `low` only for `better`; worse insights are `high` or `medium`. */
  severity: InsightSeverity;
  /** Short, plain sentence, e.g. `POST /orders p95 412 ms → 680 ms`. */
  title: string;
  /** Second line, e.g. `1,920 requests in the window · first seen in v1.8.2`. */
  detail: string;
  /** Measured value before and after; `before` is `null` for something new. */
  before: number | null;
  after: number;
  unit: "ms" | "ratio" | "count";
  /** `(after - before) / before`; `null` when `before` is `null` or 0. */
  change: number | null;
  /** Requests (or events) affected in the current window × min(|change|, 10) (new things: × 1). Sort key. */
  impact: number;
  /** Values per bucket over the current window, for a sparkline (at most 30 points). */
  series: number[];
  source: "stats" | "traces";
  link: InsightLink;
}

export interface OverviewHealth {
  /** 0 to 100, see the backlog's formula. */
  score: number;
  /** `healthy` ≥ 90, `degraded` ≥ 70, `critical` below. */
  level: "healthy" | "degraded" | "critical";
  /**
   * One plain sentence, e.g. `2 things need attention: POST /orders got 65% slower, and
   * PaymentGatewayError is new.` or `No problems found. 3 things got better.`
   */
  summary: string;
}

/** `GET api/v1/overview`. */
export interface OverviewResponse {
  windowMinutes: number;
  /** Width of one series bucket in ms. */
  bucketMs: number;
  current: CompareRange;
  previous: CompareRange;
  /** Whether statistics are kept for the whole previous window (as `RouteWindowCompareResponse`). */
  previousCovered: boolean;
  /** Why `previousCovered` is false, otherwise `null`. */
  note: string | null;
  apdexMs: number;
  health: OverviewHealth;
  totals: OverviewTotals;
  /** `null` when `previousCovered` is false. */
  previousTotals: OverviewTotals | null;
  series: OverviewSeriesPoint[];
  /** Same bucket width, aligned to `previous`; empty when `previousCovered` is false. */
  previousSeries: OverviewSeriesPoint[];
  releases: OverviewRelease[];
  status: OverviewStatusMix;
  timeByKind: OverviewTimeShare[];
  /** Worse things, highest `impact` first, at most 6. */
  attention: Insight[];
  /** Better things, highest `impact` first, at most 6. */
  better: Insight[];
}
