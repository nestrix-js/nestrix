/**
 * Route detail: why one route changed (phase 12, docs/backlog/phase-12.md).
 *
 * `GET <path>/api/v1/routes/explain?method=&route=&windowMinutes=&releaseA=&releaseB=&service=`
 * on both backends. Compares two sides of one route, built from the stored, sampled traces:
 * without releases, the last `windowMinutes` against the `windowMinutes` before them; with
 * `releaseA` and `releaseB` (both required together), traces of release A against release B
 * (any time in the store). Every figure is per request (mean over the side's traces), so sides
 * with different traffic compare fairly.
 */

/** Parameter spec. `route` is required; `method` narrows it. */
export const routeExplainParams = {
  method: { kind: "string", maxLength: 16 },
  route: { kind: "string", maxLength: 512 },
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 60,
  },
  releaseA: { kind: "string", maxLength: 255 },
  releaseB: { kind: "string", maxLength: 255 },
  service: { kind: "string", maxLength: 256 },
} as const;
export type RouteExplainParamsSpec = typeof routeExplainParams;

/** Which traces one side holds. */
export interface ExplainSideInfo {
  /** `previous` / `current` in window mode; the release name in release mode. */
  label: string;
  fromUnixMs: number;
  toUnixMs: number;
  /** Sampled traces of this route in the side. */
  traces: number;
  /** Mean root duration, ms; 0 when `traces` is 0. */
  meanMs: number;
  /** p95 of root durations over the side's traces, ms; 0 when `traces` is 0. */
  p95Ms: number;
  /** Share of traces whose root failed (5xx or thrown), 0 to 1. */
  errorRate: number;
}

/** Mean own time per request by span kind. Keys as `OverviewTimeShare.key`. */
export interface ExplainKindRow {
  key: "db" | "http-out" | "redis" | "messaging" | "app" | "other";
  beforeMs: number;
  afterMs: number;
}

/** One database statement (text without bind values, as the Queries page shows it). */
export interface ExplainStatementRow {
  /** Statement text, cut to 2,000 characters. */
  statement: string;
  /** `db.system.name` (or `db.system`), e.g. `postgresql`. */
  system: string;
  /** Mean executions per request. */
  beforeCalls: number;
  afterCalls: number;
  /** Mean time per request spent in this statement, ms. */
  beforeMs: number;
  afterMs: number;
  /** Mean duration of one execution, ms; `null` when the side has none. */
  beforeEachMs: number | null;
  afterEachMs: number | null;
}

/** One class method (method spans, D-57). Own time excludes children. */
export interface ExplainMethodRow {
  /** `Class.method`. */
  name: string;
  beforeCalls: number;
  afterCalls: number;
  /** Mean own time per request, ms. */
  beforeMs: number;
  afterMs: number;
}

/** One outgoing dependency: an HTTP host, a database server, Redis, a message broker. */
export interface ExplainDependencyRow {
  /** As the Dependencies page names it, e.g. `api.stripe.com`, `postgresql orders-db`. */
  name: string;
  kind: "http" | "db" | "redis" | "messaging";
  beforeCalls: number;
  afterCalls: number;
  /** Mean time per request in calls to it, ms. */
  beforeMs: number;
  afterMs: number;
  /** Share of its calls that failed, 0 to 1; `null` when the side has none. */
  beforeErrorRate: number | null;
  afterErrorRate: number | null;
}

/** One exception type seen on the route's spans. */
export interface ExplainErrorRow {
  /** `exception.type`, or `Error` when absent. */
  type: string;
  /** One example message, cut to 300 characters. */
  message: string;
  /** Traces with this type on any span. */
  beforeTraces: number;
  afterTraces: number;
}

export type ExplainFindingKind =
  | "new-statement"
  | "n-plus-one"
  | "slower-statement"
  | "slower-dependency"
  | "dependency-errors"
  | "slower-method"
  | "new-error"
  | "more-errors"
  | "faster";

/** One plain-language reason, ranked by how much of the change it explains. */
export interface ExplainFinding {
  kind: ExplainFindingKind;
  /** `worse` for a cause of slowing or errors; `better` for an improvement. */
  direction: "worse" | "better";
  /**
   * One sentence, e.g. `A new statement runs 6.4 times per request (SELECT … FROM order_items
   * WHERE order_id = $1), adding 214 ms.` or `api.stripe.com takes 1.1 s per request, was 640 ms.`
   */
  title: string;
  /** Mean ms per request this finding adds (positive) or removes (negative); `null` for error findings. */
  deltaMs: number | null;
  /** `deltaMs` over the change in mean duration, 0 to 1; `null` when not meaningful. */
  shareOfChange: number | null;
  /** What the UI links to, e.g. the Queries page filtered by the statement. */
  link: {
    view: "queries" | "dependencies" | "classes" | "errors";
    params: Record<string, string>;
  } | null;
}

/** A recent slow trace of the route in the `after` side, with its time by kind for a bar. */
export interface ExplainTrace {
  traceId: string;
  startUnixMs: number;
  durationMs: number;
  /** HTTP status of the root, or `null`. */
  status: number | null;
  error: boolean;
  /** Own time by kind, ms, summing to at most `durationMs`. */
  byKind: { key: ExplainKindRow["key"]; ms: number }[];
}

/** `GET api/v1/routes/explain`. */
export interface RouteExplainResponse {
  mode: "window" | "release";
  method: string | null;
  route: string;
  before: ExplainSideInfo;
  after: ExplainSideInfo;
  /** Releases seen in the stored traces of this route, newest first, for the picker. */
  releases: string[];
  /** Highest |deltaMs| first (error findings after timing ones), at most 8. Empty when a side has fewer than 5 traces. */
  findings: ExplainFinding[];
  /** One sentence summing up, e.g. `Mean time went from 214 ms to 436 ms; most of it is database time (+222 ms), mainly one new statement.` or `Not enough traces to compare (3 before, 41 after).` */
  summary: string;
  kinds: ExplainKindRow[];
  /** Highest `afterMs` (or largest change) first, at most 20. */
  statements: ExplainStatementRow[];
  /** At most 20. */
  methods: ExplainMethodRow[];
  /** At most 20. */
  dependencies: ExplainDependencyRow[];
  /** At most 20. */
  errors: ExplainErrorRow[];
  /** Slowest first, at most 10, from the `after` side. */
  slowest: ExplainTrace[];
}
