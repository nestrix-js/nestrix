/**
 * The query API v1 (backlog P2, "Public API" routes; shapes in `@nestrix-js/protocol`, P2-01).
 *
 * `@nestrix-js/protocol` is private and never published, so this file imports **types only** from it
 * (`import type`, erased at build). The parameter specs are local copies annotated with the
 * protocol's spec types: a bound, an enum value or a key that drifts from protocol fails `tsc`.
 * Nothing exported from the package entry may reach this file's declarations (a test in
 * `packages/protocol` checks that no `.d.ts` reachable from `dist/index.d.ts` names the package).
 *
 * Every function here is pure apart from reading the store and the statistics, and none throws
 * to its caller on bad input: a query string it cannot accept is a `400` with an `ApiError`.
 */
import type {
  ApiError,
  ApiErrorCode,
  ApiWarning,
  AppMapParamsSpec,
  AppMapResponse,
  ClassStatsParamsSpec,
  ClassStatsResponse,
  DependencyParamsSpec,
  ErrorGroupParamsSpec,
  ErrorGroupsResponse,
  ErrorInsightsParamsSpec,
  ErrorInsightsResponse,
  ErrorListParamsSpec,
  ErrorListResponse,
  MetaResponse,
  OverviewParamsSpec,
  ParamSpec,
  QuerySort,
  QueryStatsParamsSpec,
  QueryStatsResponse,
  RouteCompareParamsSpec,
  RouteExplainParamsSpec,
  RouteHistogramParamsSpec,
  RouteStatsParamsSpec,
  RouteStatsResponse,
  TraceListParamsSpec,
  TraceListResponse,
  TraceLogsResponse,
  TraceParamsSpec,
  TraceResponse,
  TraceTimelineParamsSpec,
  TraceType,
} from "@nestrix-js/protocol";
import { buildEmbeddedExplain } from "../explain/embedded.js";
import { methodsEnabled } from "../methods/registry.js";
import { buildEmbeddedOverview } from "../overview/embedded.js";
import {
  type ClassStatistics,
  ownAverages,
  withPreviousClasses,
} from "../stats/class-stats.js";
import {
  releaseCompare,
  routeHistogram,
  windowCompare,
} from "../stats/route-insights.js";
import {
  BUCKET_MS,
  type RouteStatistics,
  WINDOW_BUCKETS,
} from "../stats/route-stats.js";
import { buildAppMapWithPrevious } from "../store/app-map.js";
import {
  buildDependenciesWithPrevious,
  buildTimeline,
} from "../store/dependencies.js";
import { groupErrors } from "../store/error-groups.js";
import { assembleInsights, emptyHeatmap } from "../store/error-insights.js";
import { buildQueryStats } from "../store/queries.js";
import type { StoreStats, TraceStore } from "../store/store.js";
import { type DashboardResponse, JSON_TYPE } from "./respond.js";

/** `PROTOCOL_VERSION` of `@nestrix-js/protocol` (a value, so it cannot be imported). */
export const PROTOCOL_VERSION: MetaResponse["protocolVersion"] = 1;

export const traceListSpec: TraceListParamsSpec = {
  limit: { kind: "int", min: 1, max: 200, default: 50 },
  before: { kind: "cursor", maxLength: 256 },
  after: { kind: "cursor", maxLength: 256 },
  route: { kind: "string", maxLength: 512 },
  method: { kind: "string", maxLength: 16 },
  status: { kind: "enum", values: ["ok", "error", "4xx", "5xx"] },
  minDurationMs: { kind: "number", min: 0, max: 86_400_000 },
  maxDurationMs: { kind: "number", min: 0, max: 86_400_000 },
  search: { kind: "string", maxLength: 200 },
  type: { kind: "enum", values: ["http", "job", "scheduled", "other"] },
  release: { kind: "string", maxLength: 255 },
  user: { kind: "string", maxLength: 256 },
  service: { kind: "string", maxLength: 256 },
  fromUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
  toUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
};

export const dependencySpec: DependencyParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
};

export const traceTimelineSpec: TraceTimelineParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  route: { kind: "string", maxLength: 512 },
  method: { kind: "string", maxLength: 16 },
  status: { kind: "enum", values: ["ok", "error", "4xx", "5xx"] },
  search: { kind: "string", maxLength: 200 },
  type: { kind: "enum", values: ["http", "job", "scheduled", "other"] },
  release: { kind: "string", maxLength: 255 },
  user: { kind: "string", maxLength: 256 },
  service: { kind: "string", maxLength: 256 },
};

export const errorListSpec: ErrorListParamsSpec = {
  limit: { kind: "int", min: 1, max: 200, default: 50 },
  before: { kind: "cursor", maxLength: 256 },
  after: { kind: "cursor", maxLength: 256 },
  route: { kind: "string", maxLength: 512 },
  service: { kind: "string", maxLength: 256 },
};

export const errorGroupSpec: ErrorGroupParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
};

export const errorInsightsSpec: ErrorInsightsParamsSpec = {
  route: { kind: "string", maxLength: 512 },
  service: { kind: "string", maxLength: 256 },
};

export const overviewSpec: OverviewParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  apdexMs: { kind: "int", min: 10, max: 10000, default: 300 },
  service: { kind: "string", maxLength: 256 },
};

export const routeStatsSpec: RouteStatsParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
};

export const routeHistogramSpec: RouteHistogramParamsSpec = {
  method: { kind: "string", maxLength: 16 },
  route: { kind: "string", maxLength: 512 },
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
};

export const routeCompareSpec: RouteCompareParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  previous: { kind: "int", min: 1, max: 1, default: 1 },
  releaseA: { kind: "string", maxLength: 255 },
  releaseB: { kind: "string", maxLength: 255 },
  service: { kind: "string", maxLength: 256 },
};

export const routeExplainSpec: RouteExplainParamsSpec = {
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
};

export const classStatsSpec: ClassStatsParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
};

export const appMapSpec: AppMapParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
};

export const queryStatsSpec: QueryStatsParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
  sort: { kind: "enum", values: ["total", "count", "p95", "max"] },
  limit: { kind: "int", min: 1, max: 200, default: 50 },
};

export const traceSpec: TraceParamsSpec = {
  id: { kind: "string", maxLength: 32, pattern: "^[0-9a-f]{32}$" },
};

export const metaSpec: Readonly<Record<string, never>> = {};

/** More query parameters than this is a `400` before any is looked at. */
export const MAX_QUERY_PARAMS = 32;

type Values = Record<string, string | number | undefined>;
type Parsed = { ok: true; values: Values } | { ok: false; message: string };

function label(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name);
}

const INTEGER = /^-?\d{1,16}$/;
const DECIMAL = /^-?\d{1,16}(?:\.\d{1,16})?$/;

function parseOne(
  name: string,
  spec: ParamSpec,
  text: string,
): Parsed | Values[string] {
  const bad = (why: string): Parsed => ({
    ok: false,
    message: `Query parameter ${label(name)} ${why}.`,
  });
  switch (spec.kind) {
    case "int": {
      if (!INTEGER.test(text)) return bad("must be an integer");
      const n = Number(text);
      if (n < spec.min || n > spec.max) {
        return bad(`must be between ${spec.min} and ${spec.max}`);
      }
      if (spec.oneOf && !spec.oneOf.includes(n)) {
        return bad(`must be one of ${spec.oneOf.join(", ")}`);
      }
      return n;
    }
    case "number": {
      if (!DECIMAL.test(text)) return bad("must be a number");
      const n = Number(text);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
        return bad(`must be between ${spec.min} and ${spec.max}`);
      }
      return n;
    }
    case "enum":
      if (!spec.values.includes(text)) {
        return bad(`must be one of ${spec.values.join(", ")}`);
      }
      return text;
    case "cursor":
      if (text.length === 0) return bad("must not be empty");
      if (text.length > spec.maxLength) return bad("is too long");
      return text;
    case "string":
      // An empty filter is no filter: a UI that clears a field may still send the key.
      if (text.length === 0) return undefined;
      if (text.length > spec.maxLength) {
        return bad(`must be at most ${spec.maxLength} characters`);
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(text)) {
        return bad("is malformed");
      }
      return text;
  }
}

/**
 * Parses the query string of a raw request target against `spec`. Unknown parameters, repeated
 * parameters, malformed or out-of-range values, and `before` with `after`, are rejected with a
 * message naming the parameter (never echoing its value). Absent parameters take their default.
 */
export function parseQuery(
  target: unknown,
  spec: Readonly<Record<string, ParamSpec>>,
): Parsed {
  try {
    const url = typeof target === "string" ? target : "";
    const q = url.indexOf("?");
    const hash = url.indexOf("#");
    const query = q < 0 ? "" : url.slice(q + 1, hash > q ? hash : undefined);
    const params = new URLSearchParams(query);
    const values: Values = {};
    const seen = new Set<string>();
    let count = 0;
    for (const [name, text] of params) {
      if (++count > MAX_QUERY_PARAMS) {
        return { ok: false, message: "Too many query parameters." };
      }
      if (!Object.hasOwn(spec, name)) {
        return {
          ok: false,
          message: `Unknown query parameter ${label(name)}.`,
        };
      }
      if (seen.has(name)) {
        return {
          ok: false,
          message: `Query parameter ${label(name)} is given more than once.`,
        };
      }
      seen.add(name);
      const result = parseOne(name, spec[name] as ParamSpec, text);
      if (typeof result === "object" && result !== null) return result;
      values[name] = result;
    }
    for (const [name, p] of Object.entries(spec)) {
      if (
        values[name] === undefined &&
        "default" in p &&
        p.default !== undefined
      ) {
        values[name] = p.default;
      }
    }
    if (values.before !== undefined && values.after !== undefined) {
      return {
        ok: false,
        message:
          'Query parameters "before" and "after" cannot be used together.',
      };
    }
    return { ok: true, values };
  } catch {
    return { ok: false, message: "The query string could not be read." };
  }
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
): DashboardResponse {
  const body: ApiError = { error: { code, message } };
  return { status, contentType: JSON_TYPE, body: JSON.stringify(body) };
}

function ok(body: unknown): DashboardResponse {
  return { status: 200, contentType: JSON_TYPE, body: JSON.stringify(body) };
}

/** What the API handlers read. `store` is absent when this app could not attach to one. */
export interface ApiSources {
  readonly store: TraceStore | undefined;
  readonly stats: RouteStatistics;
  /** Per-class statistics, recorded by the method call sink (phase 3). */
  readonly classes: ClassStatistics;
  /** Static parts of `meta`, computed at mount. */
  readonly service: MetaResponse["service"];
  readonly sampling: MetaResponse["sampling"];
  /** Whether the host owns the OpenTelemetry provider (the `nestrixSpanProcessor()` hint). */
  readonly hostOwnsProvider: boolean;
  /** Whether `ignore.paths` is configured (statistics then leave those routes out). */
  readonly ignoresRoutes: boolean;
  /** Used for `processId` when there is no store. */
  readonly fallbackProcessId: string;
  /** `meta.profiler` (P7-02); `{ available: false, running: false }` when absent. */
  readonly profiler?: () => MetaResponse["profiler"];
}

const NO_PROFILER: MetaResponse["profiler"] = Object.freeze({
  available: false,
  running: false,
});

/** True when a `service` filter excludes this application (it names another service). */
function otherService(v: Values, sources: ApiSources): boolean {
  return v.service !== undefined && v.service !== sources.service.name;
}

const EMPTY_PAGE = { items: [], head: null, older: null, reset: false };

const EMPTY_STATS: Pick<
  StoreStats,
  | "traces"
  | "spans"
  | "bytes"
  | "evictedTraces"
  | "droppedSpans"
  | "receivedSpans"
> = {
  traces: 0,
  spans: 0,
  bytes: 0,
  evictedTraces: 0,
  droppedSpans: 0,
  receivedSpans: 0,
};

export function warningsFor(
  sources: ApiSources,
  receivedSpans: number,
): ApiWarning[] {
  const warnings: ApiWarning[] = [];
  if (sources.store === undefined) {
    warnings.push({
      code: "store-unavailable",
      message:
        "This application could not attach to the dashboard store, so trace and error lists stay empty. Route statistics are still counted. Another Nestrix instance in this process may have built the OpenTelemetry provider with the dashboard off.",
    });
  } else if (sources.hostOwnsProvider && receivedSpans === 0) {
    warnings.push({
      code: "host-span-processor",
      message:
        "No span has reached the dashboard store yet. Your application registered its own OpenTelemetry provider, so add Nestrix's processor to it: spanProcessors: [..., nestrixSpanProcessor()] (imported from @nestrix-js/nestjs).",
    });
  }
  if (sources.ignoresRoutes) {
    warnings.push({
      code: "ignored-routes",
      message:
        "Route statistics exclude the routes matched by ignore.paths, which also get no spans.",
    });
  }
  return warnings;
}

export function metaHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, metaSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const s = sources.store?.stats();
  const store = s ?? {
    ...EMPTY_STATS,
    maxTraces: 0,
    maxBytes: 0,
  };
  const body: MetaResponse = {
    protocolVersion: PROTOCOL_VERSION,
    processId: sources.store?.processId ?? sources.fallbackProcessId,
    serverTimeUnixMs: now,
    service: sources.service,
    sampling: sources.sampling,
    store: {
      traces: store.traces,
      spans: store.spans,
      bytes: store.bytes,
      maxTraces: store.maxTraces,
      maxBytes: store.maxBytes,
      evictedTraces: store.evictedTraces,
      droppedSpans: store.droppedSpans,
    },
    statistics: {
      sinceUnixMs: sources.stats.sinceUnixMs,
      windowMinutesOptions: [...routeStatsSpec.windowMinutes.oneOf],
    },
    warnings: warningsFor(sources, store.receivedSpans),
    mode: "embedded",
    profiler: { ...(sources.profiler?.() ?? NO_PROFILER) },
    runtime: { available: true },
  };
  return ok(body);
}

export function tracesHandler(
  target: unknown,
  sources: ApiSources,
): DashboardResponse {
  const parsed = parseQuery(target, traceListSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const v = parsed.values;
  const body: TraceListResponse =
    (otherService(v, sources)
      ? undefined
      : sources.store?.listTraces({
          limit: v.limit as number,
          before: v.before as string | undefined,
          after: v.after as string | undefined,
          route: v.route as string | undefined,
          method: v.method as string | undefined,
          status: v.status as "ok" | "error" | "4xx" | "5xx" | undefined,
          minDurationMs: v.minDurationMs as number | undefined,
          maxDurationMs: v.maxDurationMs as number | undefined,
          search: v.search as string | undefined,
          type: v.type as TraceType | undefined,
          release: v.release as string | undefined,
          user: v.user as string | undefined,
          fromUnixMs: v.fromUnixMs as number | undefined,
          toUnixMs: v.toUnixMs as number | undefined,
        })) ?? EMPTY_PAGE;
  return ok(body);
}

export function traceHandler(
  target: unknown,
  sources: ApiSources,
): DashboardResponse {
  const parsed = parseQuery(target, traceSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const id = parsed.values.id;
  if (typeof id !== "string") {
    return apiError(400, "bad_request", 'Query parameter "id" is required.');
  }
  const body: TraceResponse | undefined = sources.store?.getTrace(id);
  if (body === undefined) {
    return apiError(404, "not_found", "No trace with this id is stored.");
  }
  return ok(body);
}

/**
 * `GET api/v1/trace/logs?id=` (P9-07): the log lines kept next to a trace. A trace with none, or
 * not stored, answers 200 with no items.
 */
export function traceLogsHandler(
  target: unknown,
  sources: ApiSources,
): DashboardResponse {
  const parsed = parseQuery(target, traceSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const id = parsed.values.id;
  if (typeof id !== "string") {
    return apiError(400, "bad_request", 'Query parameter "id" is required.');
  }
  const body: TraceLogsResponse = sources.store?.getTraceLogs(id) ?? {
    traceId: id,
    items: [],
    truncated: false,
  };
  return ok(body);
}

export function errorsHandler(
  target: unknown,
  sources: ApiSources,
): DashboardResponse {
  const parsed = parseQuery(target, errorListSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const v = parsed.values;
  const body: ErrorListResponse =
    (otherService(v, sources)
      ? undefined
      : sources.store?.listErrors({
          limit: v.limit as number,
          before: v.before as string | undefined,
          after: v.after as string | undefined,
          route: v.route as string | undefined,
        })) ?? EMPTY_PAGE;
  return ok(body);
}

export function errorGroupsHandler(
  target: unknown,
  sources: ApiSources,
  now?: number,
): DashboardResponse {
  const parsed = parseQuery(target, errorGroupSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const windowMinutes = parsed.values.windowMinutes as number;
  const body: ErrorGroupsResponse =
    (otherService(parsed.values, sources)
      ? undefined
      : sources.store?.groupErrors(windowMinutes, now)) ??
    groupErrors([], windowMinutes, now ?? Date.now());
  return ok(body);
}

export function errorInsightsHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, errorInsightsSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const route = parsed.values.route as string | undefined;
  const body: ErrorInsightsResponse =
    (otherService(parsed.values, sources)
      ? undefined
      : sources.store?.errorInsights({ route }, now)) ??
    assembleInsights({
      now,
      heatmap: emptyHeatmap(),
      coveredFromUnixMs: now,
      releases: [],
    });
  return ok(body);
}

export function routesHandler(
  target: unknown,
  sources: ApiSources,
  now?: number,
): DashboardResponse {
  const parsed = parseQuery(target, routeStatsSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const result = sources.stats.query(
    parsed.values.windowMinutes as number,
    now,
  );
  const body: RouteStatsResponse = otherService(parsed.values, sources)
    ? { ...result, routes: [] }
    : result;
  return ok(body);
}

export function routeHistogramHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, routeHistogramSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const v = parsed.values;
  if (typeof v.route !== "string") {
    return apiError(400, "bad_request", 'Query parameter "route" is required.');
  }
  const body = routeHistogram(
    sources.stats,
    v.route,
    typeof v.method === "string" ? v.method.toUpperCase() : undefined,
    v.windowMinutes as number,
    now,
  );
  return ok(
    otherService(v, sources)
      ? {
          ...body,
          count: 0,
          buckets: body.buckets.map((b) => ({ ...b, count: 0 })),
        }
      : body,
  );
}

export function routeCompareHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, routeCompareSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const v = parsed.values;
  const a = v.releaseA;
  const b = v.releaseB;
  if ((a === undefined) !== (b === undefined)) {
    return apiError(
      400,
      "bad_request",
      'Query parameters "releaseA" and "releaseB" must be given together.',
    );
  }
  const other = otherService(v, sources);
  if (typeof a === "string" && typeof b === "string") {
    const body = releaseCompare(other ? undefined : sources.store, a, b);
    return ok(body);
  }
  const body = windowCompare(
    sources.stats,
    other ? undefined : sources.store,
    v.windowMinutes as number,
    now,
  );
  return ok(other ? { ...body, routes: [] } : body);
}

export function routeExplainHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, routeExplainSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const v = parsed.values;
  if (typeof v.route !== "string") {
    return apiError(400, "bad_request", 'Query parameter "route" is required.');
  }
  const a = v.releaseA;
  const b = v.releaseB;
  if ((a === undefined) !== (b === undefined)) {
    return apiError(
      400,
      "bad_request",
      'Query parameters "releaseA" and "releaseB" must be given together.',
    );
  }
  return ok(
    buildEmbeddedExplain(
      sources.store,
      {
        method: v.method as string | undefined,
        route: v.route,
        windowMinutes: v.windowMinutes as number,
        releaseA: a as string | undefined,
        releaseB: b as string | undefined,
      },
      now,
      otherService(v, sources),
    ),
  );
}

export function classesHandler(
  target: unknown,
  sources: ApiSources,
  now?: number,
): DashboardResponse {
  const parsed = parseQuery(target, classStatsSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const windowMinutes = parsed.values.windowMinutes as number;
  const at = now ?? Date.now();
  const store = sources.store;
  const own =
    store === undefined
      ? undefined
      : ownAverages(
          (visit) => store.scanAllTraces(visit),
          (Math.floor(at / 60_000) - windowMinutes + 1) * 60_000,
        );
  const enabled = methodsEnabled();
  const current = sources.classes.query(windowMinutes, enabled, own, at);
  // The previous window: the ring keeps 60 minutes, so only a window of 30 minutes or less has
  // one in range; and it must lie after the statistics began.
  const last = Math.floor(at / BUCKET_MS);
  const curFirst = last - windowMinutes + 1;
  const prevFirst = curFirst - windowMinutes;
  let previous: ClassStatsResponse | undefined;
  let note: string | null = null;
  if (prevFirst < last - WINDOW_BUCKETS + 1) {
    note = `Statistics are kept for the last ${WINDOW_BUCKETS} minutes, so the ${windowMinutes} minutes before the last ${windowMinutes} are not available. Compare 15 minutes instead.`;
  } else if (sources.classes.sinceUnixMs > prevFirst * BUCKET_MS) {
    note =
      "Statistics started less than two windows ago, so the previous window is only partly counted or empty.";
  } else {
    previous = sources.classes.query(
      windowMinutes,
      enabled,
      store === undefined
        ? undefined
        : ownAverages(
            (visit) => store.scanAllTraces(visit),
            prevFirst * BUCKET_MS,
            curFirst * BUCKET_MS,
          ),
      curFirst * BUCKET_MS - 1,
    );
  }
  const result = withPreviousClasses(current, previous, note);
  const body: ClassStatsResponse = otherService(parsed.values, sources)
    ? { ...result, classes: [], previousTotals: undefined }
    : result;
  return ok(body);
}

export function mapHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, appMapSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const result = buildAppMapWithPrevious(
    sources.store,
    parsed.values.windowMinutes as number,
    now,
    sources.stats.sinceUnixMs,
    sources.service.name,
  );
  const body: AppMapResponse = otherService(parsed.values, sources)
    ? { ...result, nodes: [], edges: [], previousTotals: undefined }
    : result;
  return ok(body);
}

export function queriesHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, queryStatsSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const v = parsed.values;
  const result = buildQueryStats(
    otherService(v, sources) ? undefined : sources.store,
    v.windowMinutes as number,
    now,
    (v.sort as QuerySort | undefined) ?? "total",
    v.limit as number,
  );
  const body: QueryStatsResponse = result;
  return ok(body);
}

export function dependenciesHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, dependencySpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const result = buildDependenciesWithPrevious(
    sources.store,
    parsed.values.windowMinutes as number,
    now,
    sources.stats.sinceUnixMs,
  );
  return ok(
    otherService(parsed.values, sources)
      ? { ...result, dependencies: [], previousTotals: undefined }
      : result,
  );
}

export function timelineHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, traceTimelineSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const v = parsed.values;
  const result = buildTimeline(
    otherService(v, sources) ? undefined : sources.store,
    v.windowMinutes as number,
    now,
    {
      route: v.route as string | undefined,
      method: v.method as string | undefined,
      status: v.status as "ok" | "error" | "4xx" | "5xx" | undefined,
      search: v.search as string | undefined,
      type: v.type as TraceType | undefined,
      release: v.release as string | undefined,
      user: v.user as string | undefined,
    },
  );
  return ok(result);
}

export function overviewHandler(
  target: unknown,
  sources: ApiSources,
  now: number = Date.now(),
): DashboardResponse {
  const parsed = parseQuery(target, overviewSpec);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const v = parsed.values;
  return ok(
    buildEmbeddedOverview(
      sources,
      v.windowMinutes as number,
      v.apdexMs as number,
      now,
      otherService(v, sources),
    ),
  );
}
