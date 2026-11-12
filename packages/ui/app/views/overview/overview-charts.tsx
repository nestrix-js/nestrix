import type {
  CompareRange,
  OverviewRelease,
  OverviewSeriesPoint,
} from "@nestrix-js/protocol";

import { AreaChart } from "@/components/kit/area-chart";
import { BarChart } from "@/components/kit/bar-chart";
import { formatDuration } from "@/lib/format";

/**
 * p50, p95 and p99 of the current window as lines, the previous window's p95 in grey (aligned
 * by bucket), and a vertical marker where a release first appeared. The kit's `AreaChart` with
 * the Overview's series.
 */
export function LatencyChart({
  series,
  previousSeries,
  releases,
  current,
}: {
  series: readonly OverviewSeriesPoint[];
  previousSeries: readonly OverviewSeriesPoint[];
  releases: readonly OverviewRelease[];
  current: CompareRange;
}) {
  const value = (p: OverviewSeriesPoint, key: "p50Ms" | "p95Ms" | "p99Ms") =>
    p.count > 0 ? (p[key] ?? null) : null;
  const p50 = series.map((p) => value(p, "p50Ms"));
  const p95 = series.map((p) => value(p, "p95Ms"));
  const p99 = series.map((p) => value(p, "p99Ms"));
  const prev = series.map((_, i) => {
    const p = previousSeries[i];
    return p ? value(p, "p95Ms") : null;
  });
  const peak = Math.max(
    1,
    ...[...p50, ...p95, ...p99, ...prev].filter((v): v is number => v !== null),
  );
  return (
    <AreaChart
      testId="latency-chart"
      markerTestId="release-marker"
      markerLabelTestId="release-label"
      label={`Latency percentiles over the window, peak ${formatDuration(peak)}`}
      format={formatDuration}
      fromUnixMs={current.fromUnixMs}
      toUnixMs={current.toUnixMs}
      previous={prev}
      series={[
        {
          id: "p99",
          label: "p99",
          color: "--destructive",
          values: p99,
          width: 1.5,
          dash: "5 4",
        },
        { id: "p95", label: "p95", color: "--warning", values: p95 },
        { id: "p50", label: "p50", color: "--chart-1", values: p50 },
      ]}
      markers={releases.map((r) => ({
        id: r.version,
        atUnixMs: r.firstSeenUnixMs,
        label: `${r.version} deployed ${new Date(
          r.firstSeenUnixMs,
        ).toLocaleTimeString("en", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}`,
      }))}
    />
  );
}

/** Requests per bucket as bars, the errors stacked in red on top. */
export function ThroughputBars({
  series,
}: {
  series: readonly OverviewSeriesPoint[];
}) {
  const max = Math.max(1, ...series.map((p) => p.count));
  return (
    <BarChart
      testId="throughput-bars"
      barTestId="throughput-bar"
      label={`Requests per bucket, peak ${max}; errors stacked on top`}
      max={max}
      items={series.map((p) => {
        const errors = Math.min(p.errors, p.count);
        return {
          key: String(p.timeUnixMs),
          label: String(p.timeUnixMs),
          title: `${p.count} requests, ${p.errors} errors`,
          attrs: { "data-count": p.count, "data-errors": p.errors },
          segments: [
            { value: p.count - errors, color: "--chart-1", opacity: 0.55 },
            { value: errors, color: "--destructive" },
          ],
        };
      })}
    />
  );
}
