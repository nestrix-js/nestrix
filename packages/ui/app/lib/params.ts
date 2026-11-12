import {
  errorListParams,
  routeStatsParams,
  traceListParams,
} from "@nestrix-js/protocol";
import { createParser, type inferParserType, parseAsStringLiteral } from "nuqs";

/**
 * nuqs parsers built from the protocol's parameter specs, so the UI accepts exactly what the
 * API accepts. A value that does not meet its spec parses as `null` (unset) instead of being
 * sent to the server and answered with a 400.
 */
export function numberParser(spec: {
  min: number;
  max: number;
  oneOf?: readonly number[];
  integer?: boolean;
}) {
  return createParser<number>({
    parse(raw) {
      if (raw.trim() === "") return null;
      const value = Number(raw);
      if (!Number.isFinite(value)) return null;
      if (spec.integer && !Number.isInteger(value)) return null;
      if (value < spec.min || value > spec.max) return null;
      if (spec.oneOf && !spec.oneOf.includes(value)) return null;
      return value;
    },
    serialize: String,
    eq: (a, b) => a === b,
  });
}

export function stringParser(spec: { maxLength: number; pattern?: string }) {
  const pattern = spec.pattern ? new RegExp(spec.pattern) : null;
  return createParser<string>({
    parse(raw) {
      if (raw === "" || raw.length > spec.maxLength) return null;
      if (pattern && !pattern.test(raw)) return null;
      return raw;
    },
    serialize: (value) => value,
  });
}

/** Filters of the request list; limits and cursors are the data layer's business, not the URL's. */
export const requestFilterParsers = {
  route: stringParser(traceListParams.route),
  method: stringParser(traceListParams.method),
  status: parseAsStringLiteral(traceListParams.status.values),
  minDurationMs: numberParser(traceListParams.minDurationMs),
  maxDurationMs: numberParser(traceListParams.maxDurationMs),
  search: stringParser(traceListParams.search),
  type: parseAsStringLiteral(traceListParams.type.values),
  release: stringParser(traceListParams.release),
  user: stringParser(traceListParams.user),
};
export type RequestFilters = inferParserType<typeof requestFilterParsers>;

/** For P2-10: the error list filters by route only. */
export const errorFilterParsers = {
  route: stringParser(errorListParams.route),
};

/** The service the standalone server's views are narrowed to; absent means all services. */
export const serviceParser = stringParser({ maxLength: 256 });

/** For P2-10: the routes view's window. */
export const routeWindowParser = numberParser({
  ...routeStatsParams.windowMinutes,
  integer: true,
});
