import type { TraceSummary, TraceTimelineResponse } from "@nestrix-js/protocol";

import type { ChipTone } from "@/components/kit/format";
import { formatShare } from "@/views/overview/overview-format";

type Bucket = TraceTimelineResponse["buckets"][number];

/** Sampled requests in one bucket, whatever the outcome. */
export const bucketTotal = (b: Bucket): number =>
  b.ok + b.clientError + b.serverError;

export interface TimelineTotals {
  total: number;
  clientErrors: number;
  serverErrors: number;
  /** Server errors over the total (5xx or thrown); 0 without requests. */
  errorRate: number;
  /** Requests per bucket, in order. */
  perBucket: number[];
  /** Server errors per bucket, in order. */
  serverPerBucket: number[];
}

/** What the timeline answer adds up to over the window. */
export function timelineTotals(
  data: TraceTimelineResponse | undefined,
): TimelineTotals {
  const buckets = data?.buckets ?? [];
  const total = buckets.reduce((n, b) => n + bucketTotal(b), 0);
  const serverErrors = buckets.reduce((n, b) => n + b.serverError, 0);
  return {
    total,
    clientErrors: buckets.reduce((n, b) => n + b.clientError, 0),
    serverErrors,
    errorRate: total > 0 ? serverErrors / total : 0,
    perBucket: buckets.map(bucketTotal),
    serverPerBucket: buckets.map((b) => b.serverError),
  };
}

/** The value at percentile `p` (0 to 1) by nearest rank; `null` for no values. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}

/** The slowest of `items` that started inside `[fromUnixMs, toUnixMs)`; `null` when none did. */
export function slowestInWindow(
  items: readonly TraceSummary[],
  fromUnixMs: number,
  toUnixMs: number,
): TraceSummary | null {
  let slowest: TraceSummary | null = null;
  for (const item of items) {
    if (item.startTimeUnixMs < fromUnixMs || item.startTimeUnixMs >= toUnixMs)
      continue;
    if (slowest === null || item.durationMs > slowest.durationMs)
      slowest = item;
  }
  return slowest;
}

/** A status code's chip colour: 5xx worse, 4xx caution, everything else plain. */
export function statusTone(code: number): ChipTone {
  if (code >= 500) return "worse";
  if (code >= 400) return "warn";
  return "neutral";
}

/** "1.4%" for the error rate tile; "—" when nothing was requested. */
export function formatErrorShare(totals: TimelineTotals): string {
  return totals.total > 0 ? formatShare(totals.errorRate) : "—";
}
