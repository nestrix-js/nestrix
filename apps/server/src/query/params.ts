/**
 * Query-string parsing for the query API. The semantics are the embedded dashboard's
 * (`packages/nestjs/src/dashboard/api.ts`, `parseQuery`): unknown, repeated, malformed or
 * out-of-range parameters and `before` together with `after` are a 400 naming the parameter
 * (never echoing its value); absent parameters take their default; an empty string filter is no
 * filter. The specs are annotated with `@nestrix-js/protocol`'s spec types (types only: that package
 * is private), so a bound that drifts from protocol fails `tsc`.
 */
import type {
  AppMapParamsSpec,
  ClassStatsParamsSpec,
  DependencyParamsSpec,
  ErrorGroupParamsSpec,
  ErrorInsightsParamsSpec,
  ErrorListParamsSpec,
  LogSearchParamsSpec,
  MetaParamsSpec,
  MetricCatalogParamsSpec,
  MetricSeriesParamsSpec,
  OverviewParamsSpec,
  ParamSpec,
  QueryStatsParamsSpec,
  RouteCompareParamsSpec,
  RouteExplainParamsSpec,
  RouteHistogramParamsSpec,
  RouteStatsParamsSpec,
  StandaloneParamsSpec,
  TraceListParamsSpec,
  TraceParamsSpec,
  TraceTimelineParamsSpec,
} from "@nestrix-js/protocol";

/**
 * The window of every aggregate route: `windowMinutes` (no default here, `resolveWindow` in
 * `window.ts` applies the route's own) or the range `fromUnixMs` + `toUnixMs`. Typed by
 * `StandaloneParamsSpec`, so a bound that drifts from protocol fails `tsc` (D-107).
 */
const rangeParams = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 43_200,
    oneOf: [15, 60, 360, 1440, 10_080, 43_200],
  },
  fromUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
  toUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
} as const;

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
  hasErrors: { kind: "enum", values: ["true", "false"] },
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
  fromUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
  toUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
};

export const logSearchSpec: LogSearchParamsSpec = {
  limit: { kind: "int", min: 1, max: 200, default: 100 },
  before: { kind: "cursor", maxLength: 256 },
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
  severity: {
    kind: "enum",
    values: ["trace", "debug", "info", "warn", "error", "fatal"],
  },
  text: { kind: "string", maxLength: 200 },
  match: { kind: "enum", values: ["words", "substring"] },
  traceId: { kind: "string", maxLength: 32, pattern: "^[0-9a-f]{32}$" },
  fromUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
  toUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
};

export const dependencySpec: StandaloneParamsSpec<DependencyParamsSpec> = {
  ...rangeParams,
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const traceTimelineSpec: StandaloneParamsSpec<TraceTimelineParamsSpec> =
  {
    ...rangeParams,
    route: { kind: "string", maxLength: 512 },
    method: { kind: "string", maxLength: 16 },
    status: { kind: "enum", values: ["ok", "error", "4xx", "5xx"] },
    search: { kind: "string", maxLength: 200 },
    type: { kind: "enum", values: ["http", "job", "scheduled", "other"] },
    release: { kind: "string", maxLength: 255 },
    user: { kind: "string", maxLength: 256 },
    hasErrors: { kind: "enum", values: ["true", "false"] },
    service: { kind: "string", maxLength: 256 },
    environment: { kind: "string", maxLength: 256 },
  };

export const errorListSpec: ErrorListParamsSpec = {
  limit: { kind: "int", min: 1, max: 200, default: 50 },
  before: { kind: "cursor", maxLength: 256 },
  after: { kind: "cursor", maxLength: 256 },
  route: { kind: "string", maxLength: 512 },
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const errorGroupSpec: StandaloneParamsSpec<ErrorGroupParamsSpec> = {
  ...rangeParams,
  service: { kind: "string", maxLength: 256 },
  triage: {
    kind: "enum",
    values: ["all", "open", "resolved", "regressed", "ignored"],
  },
  environment: { kind: "string", maxLength: 256 },
};

export const errorInsightsSpec: ErrorInsightsParamsSpec = {
  route: { kind: "string", maxLength: 512 },
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const overviewSpec: StandaloneParamsSpec<OverviewParamsSpec> = {
  ...rangeParams,
  apdexMs: { kind: "int", min: 10, max: 10000, default: 300 },
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const routeStatsSpec: StandaloneParamsSpec<RouteStatsParamsSpec> = {
  ...rangeParams,
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const routeHistogramSpec: StandaloneParamsSpec<RouteHistogramParamsSpec> =
  {
    method: { kind: "string", maxLength: 16 },
    route: { kind: "string", maxLength: 512 },
    ...rangeParams,
    service: { kind: "string", maxLength: 256 },
    environment: { kind: "string", maxLength: 256 },
  };

export const routeCompareSpec: StandaloneParamsSpec<RouteCompareParamsSpec> = {
  ...rangeParams,
  previous: { kind: "int", min: 1, max: 1, default: 1 },
  releaseA: { kind: "string", maxLength: 255 },
  releaseB: { kind: "string", maxLength: 255 },
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const routeExplainSpec: StandaloneParamsSpec<RouteExplainParamsSpec> = {
  method: { kind: "string", maxLength: 16 },
  route: { kind: "string", maxLength: 512 },
  ...rangeParams,
  releaseA: { kind: "string", maxLength: 255 },
  releaseB: { kind: "string", maxLength: 255 },
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const classStatsSpec: StandaloneParamsSpec<ClassStatsParamsSpec> = {
  ...rangeParams,
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const appMapSpec: StandaloneParamsSpec<AppMapParamsSpec> = {
  ...rangeParams,
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
};

export const queryStatsSpec: StandaloneParamsSpec<QueryStatsParamsSpec> = {
  ...rangeParams,
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
  sort: { kind: "enum", values: ["total", "count", "p95", "max"] },
  limit: { kind: "int", min: 1, max: 200, default: 50 },
};

export const traceSpec: TraceParamsSpec = {
  id: { kind: "string", maxLength: 32, pattern: "^[0-9a-f]{32}$" },
};

export const metaSpec: MetaParamsSpec = {};

/** Issue #18 (D-105): `metric` is required, checked by the controller. */
export const metricSeriesSpec: MetricSeriesParamsSpec = {
  metric: { kind: "string", maxLength: 128 },
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
  instance: { kind: "string", maxLength: 256 },
  fromUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
  toUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
  stepMs: { kind: "int", min: 60_000, max: 86_400_000 },
  aggregation: { kind: "enum", values: ["sum", "avg", "max", "min"] },
  by: { kind: "enum", values: ["instance"] },
};

export const metricCatalogSpec: MetricCatalogParamsSpec = {
  service: { kind: "string", maxLength: 256 },
  environment: { kind: "string", maxLength: 256 },
  fromUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
  toUnixMs: { kind: "int", min: 0, max: 8_640_000_000_000_000 },
};

/** More query parameters than this is a 400 before any is looked at. */
export const MAX_QUERY_PARAMS = 32;

export type Values = Record<string, string | number | undefined>;
export type Parsed =
  | { ok: true; values: Values }
  | { ok: false; message: string };

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

/** Parses the query string of a raw request target against `spec`. Never throws. */
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
