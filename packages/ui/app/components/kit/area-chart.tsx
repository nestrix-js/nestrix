import {
  areaPath,
  CHART_H,
  CHART_W,
  cumulativeSeries,
  linePath,
} from "@/components/kit/format";

export interface AreaSeries {
  id: string;
  label: string;
  /** A CSS custom property, e.g. `--chart-1`. */
  color: string;
  /** One value per bucket; `null` leaves a gap. */
  values: readonly (number | null)[];
  /** Stroke width; 2.25 by default. */
  width?: number;
  /** SVG dash pattern, e.g. "5 4". */
  dash?: string;
}

export interface ChartMarker {
  /** Where the marker stands on the time axis. */
  atUnixMs: number;
  /** The pill next to it ("v1.8.2 deployed 10:42"). */
  label: string;
  /** Any stable id (the marker's React key). */
  id: string;
}

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * A time-series chart in plain SVG: each series as a line, optionally filled (`area`) or stacked
 * (`stacked`, series drawn as running totals, first series at the bottom); `previous` is the same
 * measure over the previous window as a grey line (aligned by bucket); `markers` are vertical
 * lines with a label (a release first seen). The x axis runs from `fromUnixMs` to `toUnixMs` with
 * five clock ticks. `label` states the takeaway for screen readers; `format` writes the maximum
 * at the top left.
 */
export function AreaChart({
  series,
  previous,
  markers = [],
  fromUnixMs,
  toUnixMs,
  format = (n) => String(Math.round(n)),
  label,
  testId = "area-chart",
  markerTestId = "chart-marker",
  markerLabelTestId = "chart-marker-label",
  area = false,
  stacked = false,
  heightClass = "h-56",
}: {
  series: readonly AreaSeries[];
  previous?: readonly (number | null)[];
  markers?: readonly ChartMarker[];
  fromUnixMs: number;
  toUnixMs: number;
  format?: (value: number) => string;
  label: string;
  testId?: string;
  markerTestId?: string;
  markerLabelTestId?: string;
  /** Fill under each line (a soft tint). Implied by `stacked`. */
  area?: boolean;
  stacked?: boolean;
  heightClass?: string;
}) {
  const drawn = stacked
    ? cumulativeSeries(series.map((s) => s.values))
    : series.map((s) => s.values);
  const max = Math.max(
    1,
    ...[...drawn.flat(), ...(previous ?? [])].filter(
      (v): v is number => v !== null,
    ),
  );
  const span = Math.max(1, toUnixMs - fromUnixMs);
  const marks = markers
    .map((m) => ({ ...m, x: ((m.atUnixMs - fromUnixMs) / span) * 100 }))
    .filter((m) => m.x >= 0 && m.x <= 100);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => hhmm(fromUnixMs + f * span));
  // Stacked areas are painted from the top total down so each lower one covers its part.
  const order = stacked
    ? series.map((_, i) => series.length - 1 - i)
    : series.map((_, i) => i);
  const prevPath = previous ? linePath(previous, max) : "";
  return (
    <div data-testid={testId} className="space-y-1">
      <div className="relative">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          className={`${heightClass} w-full`}
        >
          {[0.2, 0.4, 0.6, 0.8].map((f) => (
            <line
              key={f}
              x1="0"
              x2={CHART_W}
              y1={CHART_H * f}
              y2={CHART_H * f}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {prevPath !== "" && (
            <path
              data-line="prev"
              d={prevPath}
              fill="none"
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {order.map((i) => {
            const s = series[i];
            const values = drawn[i];
            if (!s || !values) return null;
            const d = linePath(values, max);
            if (d === "") return null;
            return (
              <g key={s.id}>
                {(area || stacked) && (
                  <path
                    d={areaPath(values, max)}
                    fill={`var(${s.color})`}
                    opacity={stacked ? 0.55 : 0.12}
                  />
                )}
                <path
                  data-line={s.id}
                  d={d}
                  fill="none"
                  stroke={`var(${s.color})`}
                  strokeWidth={s.width ?? 2.25}
                  strokeDasharray={s.dash}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {marks.map((m) => (
            <line
              key={m.id}
              data-testid={markerTestId}
              x1={(m.x / 100) * CHART_W}
              x2={(m.x / 100) * CHART_W}
              y1="0"
              y2={CHART_H}
              stroke="var(--chart-4)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <span className="pointer-events-none absolute left-0 top-0 text-[10px] text-muted-foreground">
          max {format(max)}
        </span>
        {marks.map((m) => (
          <span
            key={m.id}
            data-testid={markerLabelTestId}
            className="absolute top-3 whitespace-nowrap rounded-full bg-secondary px-2 py-0.5 text-xs"
            style={{
              left: `${m.x}%`,
              transform:
                m.x > 70 ? "translateX(calc(-100% - 6px))" : "translateX(6px)",
            }}
          >
            {m.label}
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
