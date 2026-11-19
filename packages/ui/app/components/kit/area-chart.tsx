import {
  crossesDay,
  gridTicks,
  timeAxisLabels,
} from "@/components/kit/chart-axis";
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

/**
 * A time-series chart in plain SVG: each series as a line, optionally filled (`area`) or stacked
 * (`stacked`, series drawn as running totals, first series at the bottom); `previous` is the same
 * measure over the previous window as a grey line (aligned by bucket); `markers` are vertical
 * lines with a label (a release first seen). The x axis runs from `fromUnixMs` to `toUnixMs` with
 * five clock ticks (HH:mm; dates only when the range crosses midnight). Two to four round
 * gridlines carry their value, written by `format`; `integer` keeps them whole numbers (counts).
 * `label` states the takeaway for screen readers.
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
  integer = false,
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
  /** The gridlines are whole numbers: the chart counts things. */
  integer?: boolean;
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
  const ticks = timeAxisLabels(
    [0, 0.25, 0.5, 0.75, 1].map((f) => (fromUnixMs + f * span) / 1000),
    crossesDay(fromUnixMs, toUnixMs),
  );
  // The line of a value sits where `linePath` draws it.
  const gridY = (v: number) => CHART_H - 4 - (v / max) * (CHART_H - 12);
  const grid = gridTicks(max, integer);
  // Stacked areas are painted from the top total down so each lower one covers its part.
  const order = stacked
    ? series.map((_, i) => series.length - 1 - i)
    : series.map((_, i) => i);
  const gridLines = (stroke: string, opacity: number) =>
    grid.map((v) => (
      <line
        key={v}
        data-testid="chart-gridline"
        x1="0"
        x2={CHART_W}
        y1={gridY(v)}
        y2={gridY(v)}
        stroke={stroke}
        strokeOpacity={opacity}
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    ));
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
          {!stacked && gridLines("var(--border)", 1)}
          {prevPath !== "" && (
            <path
              data-line="prev"
              d={prevPath}
              fill="none"
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
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
                    opacity={stacked ? 1 : 0.12}
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
          {/* Over opaque fills, so a light line in the page's colour. */}
          {stacked && gridLines("var(--background)", 0.45)}
          {marks.map((m) => (
            <line
              key={m.id}
              data-testid={markerTestId}
              x1={(m.x / 100) * CHART_W}
              x2={(m.x / 100) * CHART_W}
              y1="0"
              y2={CHART_H}
              stroke="var(--foreground)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {grid.map((v) => (
          <span
            key={v}
            data-testid="chart-gridlabel"
            className="pointer-events-none absolute left-0 -translate-y-full rounded-sm bg-background/80 px-0.5 text-[10px] leading-none text-muted-foreground"
            style={{ top: `${(gridY(v) / CHART_H) * 100}%` }}
          >
            {format(v)}
          </span>
        ))}
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
          <span key={i} className="whitespace-pre-line text-center">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
