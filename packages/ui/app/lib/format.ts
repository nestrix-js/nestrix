/** "12.4 ms", "1.23 s": durations in fixed units, enough precision to compare rows. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms < 100 ? ms.toFixed(1) : ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** A duration's share of the slowest one listed, in percent; 0 when there is no positive maximum. */
export const durationPct = (durationMs: number, maxMs: number): number =>
  maxMs > 0 ? Math.min(Math.max((durationMs / maxMs) * 100, 0), 100) : 0;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "5 seconds ago", "now": coarse relative time for list rows. */
export function formatRelative(thenMs: number, nowMs: number): string {
  const seconds = Math.round((thenMs - nowMs) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 5) return "now";
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86_400), "day");
}

export type SamplingMeta =
  | { owner: "nestrix"; rate: number }
  | { owner: "host"; rate: null };

/**
 * In the standalone server, statistics come from the stored spans, not from counters in the
 * senders, so they reflect whatever sampling the senders apply (D-61).
 */
export const STANDALONE_STATISTICS_NOTE =
  "Statistics are counted from the stored spans, so they reflect the sampling of the services that send them.";

/** The notice for lists; null when every request is stored. */
export function samplingNotice(sampling: SamplingMeta): string | null {
  if (sampling.rate === null) return "lists may be sampled";
  if (sampling.rate < 1) return "lists are sampled";
  return null;
}
