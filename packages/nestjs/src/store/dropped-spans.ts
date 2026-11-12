import type { DroppedSpans, SpanRecord } from "./protocol-types.js";

const TOTAL = "nestrix.trace.spans_dropped";
const KIND_PREFIX = `${TOTAL}.`;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * `TraceResponse.droppedSpans` (D-78): what each service's SDK counted but did not record, summed
 * over the trace's spans (`nestrix.trace.spans_dropped`, and `.<kind>` for `byKind`), plus what
 * the standalone server refused (`byServer`). `undefined` when both are 0. A copy of the server's
 * helper in `apps/server/src/query/dropped-spans.ts` (the packages share no runtime code).
 */
export function droppedSpansOf(
  spans: readonly Pick<SpanRecord, "attributes">[],
  byServer: number,
): DroppedSpans | undefined {
  let app = 0;
  const byKind: Record<string, number> = {};
  for (const span of spans) {
    const attributes = span.attributes;
    for (const key of Object.keys(attributes)) {
      if (key === TOTAL) {
        app += count(attributes[key]);
      } else if (
        key.startsWith(KIND_PREFIX) &&
        key.length > KIND_PREFIX.length
      ) {
        const n = count(attributes[key]);
        if (n > 0) {
          const kind = key.slice(KIND_PREFIX.length);
          byKind[kind] = (byKind[kind] ?? 0) + n;
        }
      }
    }
  }
  const server = count(byServer);
  const total = app + server;
  return total > 0 ? { total, byKind, byServer: server } : undefined;
}
