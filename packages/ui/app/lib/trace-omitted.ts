import type { DroppedSpans } from "@nestrix-js/protocol";

import { TIME_KINDS } from "@/views/overview/overview-format";

/** Where the `maxSpansPerTrace` option is documented (the README's Options section). */
export const MAX_SPANS_DOCS_URL =
  "https://github.com/nestrix-js/nestrix/blob/main/packages/nestjs/README.md#large-traces-maxspanspertrace";

/** The kinds in the order the Overview lists them. */
const KIND_ORDER = Object.keys(TIME_KINDS);

export interface OmittedSummary {
  total: number;
  /** Dropped over the app's `maxSpansPerTrace`. */
  app: number;
  /** Dropped over the standalone server's per-trace cap. */
  server: number;
  /** App-side counts by kind, labelled as the Overview labels them; zero counts left out. */
  kinds: { key: string; label: string; count: number }[];
}

/** Reads `TraceResponse.droppedSpans` into what the banner shows; undefined when nothing was dropped. */
export function summarizeDropped(
  dropped: DroppedSpans | undefined,
): OmittedSummary | undefined {
  if (!dropped || !(dropped.total > 0)) return undefined;
  const server = Math.min(Math.max(dropped.byServer ?? 0, 0), dropped.total);
  const entries = Object.entries(dropped.byKind ?? {}).filter(
    ([, count]) => count > 0,
  );
  const rank = (key: string) => {
    const i = KIND_ORDER.indexOf(key);
    return i < 0 ? KIND_ORDER.length : i;
  };
  entries.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  return {
    total: dropped.total,
    app: dropped.total - server,
    server,
    kinds: entries.map(([key, count]) => ({
      key,
      label: TIME_KINDS[key as keyof typeof TIME_KINDS]?.label ?? key,
      count,
    })),
  };
}

const plural = (n: number) => (n === 1 ? "span" : "spans");

/** "(omitted 12 spans)". */
export function omittedLabel(total: number): string {
  return `(omitted ${total} ${plural(total)})`;
}

/** "This trace has 12 more spans that were counted but not recorded." */
export function bannerHeadline(total: number): string {
  return `This trace has ${total} more ${plural(total)} that ${total === 1 ? "was" : "were"} counted but not recorded.`;
}

/** "5 over the app's span limit, 7 over the server's"; only the parts that are non-zero. */
export function splitLine(s: OmittedSummary): string {
  const parts: string[] = [];
  if (s.app > 0) parts.push(`${s.app} over the app's span limit`);
  if (s.server > 0) parts.push(`${s.server} over the server's`);
  return parts.join(", ");
}
