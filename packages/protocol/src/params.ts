/**
 * Query-parameter specs for the query API (v1).
 *
 * Each spec is an `as const` object so every bound and enum value is a literal type.
 * Two consumers, one source:
 *
 * - `@nestrix-js/ui` builds nuqs parsers from the values (`kind` picks the parser,
 *   `min`/`max`/`values`/`default` configure it).
 * - `@nestrix-js/nestjs` may only `import type` from this private package, so it cannot
 *   read the values. It writes its own copy annotated with the spec type, and `tsc`
 *   fails when the copy drifts (a different bound, a missing or extra key):
 *
 *   ```ts
 *   import type { TraceListParamsSpec } from '@nestrix-js/protocol';
 *   const spec: TraceListParamsSpec = { limit: { kind: 'int', min: 1, max: 200, default: 50 }, ... };
 *   ```
 *
 * Semantics the shapes cannot express: `before` and `after` are mutually exclusive
 * (both given is a `400`); `service` filters by `service.name` (the standalone server serves several services; an embedded dashboard answers empty unless it equals its own name); a parameter absent from the query string takes its
 * `default` when it has one and is unset otherwise; unknown parameters are a `400`.
 */

/** Integer in `[min, max]`; `oneOf`, when present, narrows it to those values. */
export interface IntParam {
  readonly kind: "int";
  readonly min: number;
  readonly max: number;
  readonly oneOf?: readonly number[];
  readonly default?: number;
}

/** Finite number in `[min, max]`. */
export interface NumberParam {
  readonly kind: "number";
  readonly min: number;
  readonly max: number;
  readonly default?: number;
}

/** String of at most `maxLength` characters; `pattern` is a regular-expression source, when present. */
export interface StringParam {
  readonly kind: "string";
  readonly maxLength: number;
  readonly pattern?: string;
  readonly default?: string;
}

/** One of `values`. */
export interface EnumParam {
  readonly kind: "enum";
  readonly values: readonly string[];
  readonly default?: string;
}

/** Opaque paging cursor of at most `maxLength` characters. */
export interface CursorParam {
  readonly kind: "cursor";
  readonly maxLength: number;
}

export type ParamSpec =
  | IntParam
  | NumberParam
  | StringParam
  | EnumParam
  | CursorParam;

/** `GET <path>/api/v1/traces` */
export const traceListParams = {
  limit: { kind: "int", min: 1, max: 200, default: 50 },
  before: { kind: "cursor", maxLength: 256 },
  after: { kind: "cursor", maxLength: 256 },
  route: { kind: "string", maxLength: 512 },
  method: { kind: "string", maxLength: 16 },
  status: { kind: "enum", values: ["ok", "error", "4xx", "5xx"] },
  minDurationMs: { kind: "number", min: 0, max: 86_400_000 },
  search: { kind: "string", maxLength: 200 },
  /**
   * `http`, `scheduled` and `other` match the trace's root (`TraceSummary.type`). `job` matches
   * every trace with `TraceSummary.hasJob`, whatever its root, so a request that enqueued a
   * job appears under both `http` and `job`.
   */
  type: { kind: "enum", values: ["http", "job", "scheduled", "other"] },
  release: { kind: "string", maxLength: 255 },
  user: { kind: "string", maxLength: 256 },
  service: { kind: "string", maxLength: 256 },
} as const;
export type TraceListParamsSpec = typeof traceListParams;

/** `GET <path>/api/v1/errors` */
export const errorListParams = {
  limit: { kind: "int", min: 1, max: 200, default: 50 },
  before: { kind: "cursor", maxLength: 256 },
  after: { kind: "cursor", maxLength: 256 },
  route: { kind: "string", maxLength: 512 },
  service: { kind: "string", maxLength: 256 },
} as const;
export type ErrorListParamsSpec = typeof errorListParams;

/** `GET <path>/api/v1/routes` */
export const routeStatsParams = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
} as const;
export type RouteStatsParamsSpec = typeof routeStatsParams;

/** `GET <path>/api/v1/classes` */
export const classStatsParams = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
} as const;
export type ClassStatsParamsSpec = typeof classStatsParams;

/** `GET <path>/api/v1/map` */
export const appMapParams = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
} as const;
export type AppMapParamsSpec = typeof appMapParams;

/** `GET <path>/api/v1/trace?id=<traceId>`: a 32-character lowercase hex trace id. */
export const traceParams = {
  id: { kind: "string", maxLength: 32, pattern: "^[0-9a-f]{32}$" },
} as const;
export type TraceParamsSpec = typeof traceParams;

/** `GET <path>/api/v1/meta` takes no parameters. */
export const metaParams = {} as const;
export type MetaParamsSpec = typeof metaParams;

/**
 * `POST <path>/api/v1/profiles`: the JSON body's fields (not the query string). Unknown fields are
 * a `400`; the body is at most 1,024 bytes.
 */
export const profileStartBody = {
  durationSeconds: { kind: "int", min: 1, max: 120, default: 30 },
} as const;
export type ProfileStartBodySpec = typeof profileStartBody;

/** `GET <path>/api/v1/profiles/<id>` and `.../<id>/download`: the path segment `<id>`. */
export const profileIdParams = {
  id: { kind: "string", maxLength: 16, pattern: "^[0-9a-f]{16}$" },
} as const;
export type ProfileIdParamsSpec = typeof profileIdParams;
