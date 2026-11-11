// Pure logic of the trace insights: slow database spans and repeated statements. No React.
import type { SpanRecord } from "@nestrix-js/protocol";

/** A database span longer than this is highlighted in the waterfall. */
export const SLOW_DB_MS = 100;
/** A statement seen this many times in one trace is listed as repeated. */
export const REPEAT_MIN_COUNT = 3;

/** A database span carries `db.system.name` (current convention) or `db.system` (legacy). */
export const isDbSpan = (span: SpanRecord): boolean =>
  span.attributes["db.system.name"] !== undefined ||
  span.attributes["db.system"] !== undefined;

export const isSlowDbSpan = (span: SpanRecord): boolean =>
  isDbSpan(span) && span.durationMs > SLOW_DB_MS;

export interface RepeatedQuery {
  /** The statement, `db.query.text`. */
  text: string;
  count: number;
  totalMs: number;
  spanIds: string[];
}

/**
 * Statements (`db.query.text` of database spans) that occur `minCount` or more times, most
 * total time first (ties: higher count, then text).
 */
export function repeatedQueries(
  spans: readonly SpanRecord[],
  minCount = REPEAT_MIN_COUNT,
): RepeatedQuery[] {
  const groups = new Map<string, RepeatedQuery>();
  for (const span of spans) {
    if (!isDbSpan(span)) continue;
    const text = span.attributes["db.query.text"];
    if (typeof text !== "string" || text === "") continue;
    const group = groups.get(text) ?? {
      text,
      count: 0,
      totalMs: 0,
      spanIds: [],
    };
    group.count += 1;
    group.totalMs += span.durationMs;
    group.spanIds.push(span.spanId);
    groups.set(text, group);
  }
  return [...groups.values()]
    .filter((g) => g.count >= minCount)
    .sort(
      (a, b) =>
        b.totalMs - a.totalMs ||
        b.count - a.count ||
        (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
    );
}
