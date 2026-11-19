/** "12.4 ms", "1.23 s": durations in fixed units, enough precision to compare rows. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms < 100 ? ms.toFixed(1) : ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

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

/** Wording shared with the MCP server; it lives in `@nestrix-js/protocol` (issue #45). */
export { STANDALONE_STATISTICS_NOTE } from "@nestrix-js/protocol";

/** The header chip about sampling, with its tooltip; null when every request is stored. */
export function samplingNotice(
  sampling: SamplingMeta,
): { text: string; title: string } | null {
  if (sampling.rate === null)
    return {
      text: "traces may be sampled",
      title:
        "The host application owns the sampler, so Nestrix cannot say how many traces are kept. Lists and anything built from traces show only the kept ones; route statistics count every request.",
    };
  if (sampling.rate < 1) {
    const percent = Number((sampling.rate * 100).toFixed(2));
    return {
      text: `traces sampled at ${percent}%`,
      title: `Nestrix keeps ${percent}% of traces. Request lists and anything built from traces show only the kept ones; figures marked "counted before sampling" include every request.`,
    };
  }
  return null;
}

/** Pages whose data is not made of sampled traces; the header chip is not shown on them. */
const UNSAMPLED_PAGES = [
  "/logs",
  "/runtime",
  "/metrics",
  "/slos",
  "/alerts",
  "/settings",
];

/** Whether the header's sampling chip applies to the page at `pathname`. */
export function showsSamplingNotice(pathname: string): boolean {
  return !UNSAMPLED_PAGES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}
