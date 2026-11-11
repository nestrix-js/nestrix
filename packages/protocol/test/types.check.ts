/**
 * Type-level checks, compiled by `tsc -b` (tsconfig.test.json) and never run.
 * A `@ts-expect-error` that stops erroring fails the build, so each one proves drift is caught.
 */
import type {
  ErrorListParamsSpec,
  RouteStatsParamsSpec,
  TraceListParamsSpec,
  TraceParamsSpec,
} from "../src/index.js";

// A copy that matches compiles. This is what @nestrix/nestjs writes.
export const matching: TraceListParamsSpec = {
  limit: { kind: "int", min: 1, max: 200, default: 50 },
  before: { kind: "cursor", maxLength: 256 },
  after: { kind: "cursor", maxLength: 256 },
  route: { kind: "string", maxLength: 512 },
  method: { kind: "string", maxLength: 16 },
  status: { kind: "enum", values: ["ok", "error", "4xx", "5xx"] },
  minDurationMs: { kind: "number", min: 0, max: 86_400_000 },
  search: { kind: "string", maxLength: 200 },
};

export const matchingErrors: ErrorListParamsSpec = {
  limit: { kind: "int", min: 1, max: 200, default: 50 },
  before: { kind: "cursor", maxLength: 256 },
  after: { kind: "cursor", maxLength: 256 },
  route: { kind: "string", maxLength: 512 },
};

export const matchingRoutes: RouteStatsParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
};

export const matchingTrace: TraceParamsSpec = {
  id: { kind: "string", maxLength: 32, pattern: "^[0-9a-f]{32}$" },
};

// A different max.
export const driftedMax: TraceListParamsSpec = {
  ...matching,
  // @ts-expect-error max 100 is not max 200
  limit: { kind: "int", min: 1, max: 100, default: 50 },
};

// A different maximum length.
export const driftedLength: TraceListParamsSpec = {
  ...matching,
  // @ts-expect-error maxLength 100 is not 200
  search: { kind: "string", maxLength: 100 },
};

// A different enum member list.
export const driftedEnum: TraceListParamsSpec = {
  ...matching,
  // @ts-expect-error a member is missing
  status: { kind: "enum", values: ["ok", "error", "4xx"] },
};

// A missing parameter.
// @ts-expect-error `search` is missing
export const missingKey: TraceListParamsSpec = (() => {
  const { search: _search, ...rest } = matching;
  return rest;
})();

// An extra parameter.
export const extraKey: ErrorListParamsSpec = {
  ...matchingErrors,
  // @ts-expect-error `status` is not an errors parameter
  status: { kind: "enum", values: ["ok"] },
};

// A different default.
export const driftedDefault: RouteStatsParamsSpec = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    // @ts-expect-error default 60 is not 15
    default: 60,
  },
};
