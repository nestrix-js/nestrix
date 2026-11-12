import type {
  CompareRange,
  OverviewRelease,
  OverviewSeriesPoint,
} from "@nestrix-js/protocol";
import type * as React from "react";

import { formatDuration } from "@/lib/format";
import { sparklinePoints } from "@/views/dependencies/sparkline";
import {
  type DonutSlice,
  ringDasharray,
} from "@/views/overview/overview-format";

const cssVar = (name: string) => `var(${name})`;

/** A line over the values of a series, in one colour (`color` is a CSS custom property). */
export function TrendLine({
  values,
  color,
  label,
  width = 96,
  height = 28,
  area = false,
  stretch = false,
}: {
  values: readonly number[];
  color: string;
  label: string;
  width?: number;
  height?: number;
  /** Fills the space under the line. */
  area?: boolean;
  /** Fills the width of its container (the line keeps its stroke width). */
  stretch?: boolean;
}) {
  if (values.length === 0) return null;
  const points = sparklinePoints(values, width, height);
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="trend"
      width={stretch ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="shrink-0 overflow-visible"
    >
      <title>{label}</title>
      {area && (
        <polygon
          points={`2,${height} ${points} ${width - 2},${height}`}
          fill={cssVar(color)}
          opacity={0.12}
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={cssVar(color)}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** The health score as a ring that is `score` percent full, the number inside. */
export function ScoreRing({
  score,
  color,
  label,
}: {
  score: number;
  color: string;
  label: string;
}) {
  const r = 48;
  return (
    <div className="relative size-28 shrink-0">
      <svg
        viewBox="0 0 112 112"
        role="img"
        aria-label={label}
        className="size-28 -rotate-90"
      >
        <title>{label}</title>
        <circle
          cx="56"
          cy="56"
          r={r}
          fill="none"
          stroke="var(--muted)"
          strokeWidth="10"
        />
        <circle
          cx="56"
          cy="56"
          r={r}
          fill="none"
          stroke={cssVar(color)}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={ringDasharray(score / 100, r)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          data-testid="health-score"
          className="text-3xl font-bold leading-none"
        >
          {score}
        </span>
        <span className="text-xs text-muted-foreground">health</span>
      </div>
    </div>
  );
}

export const DONUT_RADIUS = 54;

/** A donut of arcs; `children` is the centre text. */
export function Donut({
  slices,
  label,
  children,
  testId,
  size = 150,
}: {
  slices: readonly DonutSlice[];
  label: string;
  children: React.ReactNode;
  testId: string;
  size?: number;
}) {
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      data-testid={testId}
    >
      <svg
        viewBox="0 0 140 140"
        role="img"
        aria-label={label}
        width={size}
        height={size}
        className="-rotate-90"
      >
        <title>{label}</title>
        <circle
          cx="70"
          cy="70"
          r={DONUT_RADIUS}
          fill="none"
          stroke="var(--muted)"
          strokeWidth="18"
        />
        {slices.map((slice) => (
          <circle
            key={slice.key}
            data-testid={`${testId}-slice`}
            data-slice={slice.key}
            data-fraction={slice.fraction.toFixed(4)}
            cx="70"
            cy="70"
            r={DONUT_RADIUS}
            fill="none"
            stroke={cssVar(slice.color)}
            strokeWidth="18"
            strokeDasharray={slice.dasharray}
            strokeDashoffset={slice.dashoffset}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}

const W = 860;
const H = 220;

/** Indexes of `values` as `M`/`L` path commands; a `null` ends the segment (a gap). */
function pathOf(values: readonly (number | null)[], max: number): string {
  const step = values.length > 1 ? W / (values.length - 1) : 0;
  let d = "";
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    const x = (values.length > 1 ? i * step : W / 2).toFixed(1);
    const y = (H - 4 - (v / max) * (H - 12)).toFixed(1);
    d += `${open ? "L" : "M"}${x} ${y} `;
    open = true;
  });
  return d.trim();
}

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * p50, p95 and p99 of the current window as lines, the previous window's p95 in grey (aligned
 * by bucket), and a vertical marker where a release first appeared.
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
  const max = Math.max(
    1,
    ...[...p50, ...p95, ...p99, ...prev].filter((v): v is number => v !== null),
  );
  const span = Math.max(1, current.toUnixMs - current.fromUnixMs);
  const marks = releases
    .map((r) => ({
      ...r,
      x: ((r.firstSeenUnixMs - current.fromUnixMs) / span) * 100,
    }))
    .filter((r) => r.x >= 0 && r.x <= 100);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    hhmm(current.fromUnixMs + f * span),
  );
  const lines = [
    {
      id: "prev",
      d: pathOf(prev, max),
      color: "--muted-foreground",
      width: 1.5,
      dash: undefined,
    },
    {
      id: "p99",
      d: pathOf(p99, max),
      color: "--destructive",
      width: 1.5,
      dash: "5 4",
    },
    {
      id: "p95",
      d: pathOf(p95, max),
      color: "--warning",
      width: 2.25,
      dash: undefined,
    },
    {
      id: "p50",
      d: pathOf(p50, max),
      color: "--chart-1",
      width: 2.25,
      dash: undefined,
    },
  ];
  return (
    <div data-testid="latency-chart" className="space-y-1">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Latency percentiles over the window, peak ${formatDuration(max)}`}
          className="h-56 w-full"
        >
          {[0.2, 0.4, 0.6, 0.8].map((f) => (
            <line
              key={f}
              x1="0"
              x2={W}
              y1={H * f}
              y2={H * f}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {lines.map((line) =>
            line.d === "" ? null : (
              <path
                key={line.id}
                data-line={line.id}
                d={line.d}
                fill="none"
                stroke={cssVar(line.color)}
                strokeWidth={line.width}
                strokeDasharray={line.dash}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ),
          )}
          {marks.map((m) => (
            <line
              key={m.version}
              data-testid="release-marker"
              x1={(m.x / 100) * W}
              x2={(m.x / 100) * W}
              y1="0"
              y2={H}
              stroke="var(--chart-4)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <span className="pointer-events-none absolute left-0 top-0 text-[10px] text-muted-foreground">
          max {formatDuration(max)}
        </span>
        {marks.map((m) => (
          <span
            key={m.version}
            data-testid="release-label"
            className="absolute top-3 whitespace-nowrap rounded-full bg-secondary px-2 py-0.5 text-xs"
            style={{
              left: `${m.x}%`,
              transform:
                m.x > 70 ? "translateX(calc(-100% - 6px))" : "translateX(6px)",
            }}
          >
            {m.version} deployed {hhmm(m.firstSeenUnixMs)}
          </span>
        ))}
      </div>
      <div className="flex justify-between font-mono text-xs text-muted-foreground">
        {ticks.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the position is the tick
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
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
    <div
      role="img"
      aria-label={`Requests per bucket, peak ${max}; errors stacked on top`}
      data-testid="throughput-bars"
      className="flex h-36 items-end gap-0.5"
    >
      {series.map((p) => {
        const errors = Math.min(p.errors, p.count);
        return (
          <div
            key={p.timeUnixMs}
            data-testid="throughput-bar"
            data-count={p.count}
            data-errors={p.errors}
            className="flex h-full flex-1 flex-col justify-end"
            title={`${p.count} requests, ${p.errors} errors`}
          >
            <div
              className="rounded-t-sm bg-destructive"
              style={{
                height: `${(errors / max) * 100}%`,
                minHeight: errors > 0 ? 2 : 0,
              }}
            />
            <div
              style={{
                height: `${((p.count - errors) / max) * 100}%`,
                background: cssVar("--chart-1"),
                opacity: 0.55,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
