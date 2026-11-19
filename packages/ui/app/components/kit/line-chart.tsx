import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";

import { hhmm } from "./chart-axis";
import { Swatch } from "./donut";
import { cssColor, NO_LEGEND, timeAxis, valueAxis } from "./uplot-preset";

export interface ChartSeries {
  label: string;
  /** A CSS custom property holding the colour, e.g. `--chart-1`; read at draw time. */
  color: string;
  /** One value per x; `null` leaves a gap. */
  values: (number | null)[];
}

interface ChartProps {
  /** Unix seconds. */
  xs: number[];
  series: ChartSeries[];
  /** Formats y values for the axis and the legend. */
  format?: (value: number) => string;
  /** Accessible name of the chart. */
  label: string;
  height?: number;
  testId?: string;
  /**
   * The y axis spans at least 0 to this value (default 1), so a chart of small numbers (CPU as a
   * fraction of a core, seconds) is not drawn flat against a larger floor.
   */
  minMax?: number;
  /**
   * Makes the chart selectable: a click reports the time under the cursor (`fromSeconds` equals
   * `toSeconds`), a drag reports the range it covers (Unix seconds, ascending).
   */
  onRange?: (fromSeconds: number, toSeconds: number) => void;
}

/** True when a value has no non-null neighbour, so a line would not draw it. */
function hasIsolatedPoint(
  u: uPlot,
  seriesIdx: number,
  idx0: number,
  idx1: number,
): boolean {
  const values = u.data[seriesIdx] as (number | null | undefined)[];
  const set = (i: number) => values[i] !== null && values[i] !== undefined;
  for (let i = idx0; i <= idx1; i++) {
    if (set(i) && !(i > idx0 && set(i - 1)) && !(i < idx1 && set(i + 1))) {
      return true;
    }
  }
  return false;
}

/** Re-reads colours when the system switches between light and dark. */
function useColorScheme(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setVersion((v) => v + 1);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return version;
}

/**
 * A uPlot line chart. uPlot only sets styles through the CSSOM, which the dashboard's
 * `style-src 'self'` allows. The plot is rebuilt when the series definition or the colour
 * scheme changes and only has its data replaced when just the values change (every poll).
 */
export function Chart({
  xs,
  series,
  format = (v) => String(v),
  label,
  height = 160,
  testId,
  minMax = 1,
  onRange,
}: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const scheme = useColorScheme();
  // The point under the cursor, for the legend's readout; null when the pointer is away.
  const [hover, setHover] = useState<number | null>(null);
  const latest = useRef({ xs, series, format, onRange });
  latest.current = { xs, series, format, onRange };
  const selectable = onRange !== undefined;
  // The plot is rebuilt for these only.
  const shape = JSON.stringify(series.map((s) => [s.label, s.color]));

  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` and `scheme` stand for what the plot is built from; data and format are read through `latest`
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { xs: x0, series: s0 } = latest.current;
    let dragged = false;
    const plot = new uPlot(
      {
        width: el.clientWidth || 480,
        height,
        legend: NO_LEGEND,
        axes: [timeAxis(), valueAxis((v) => latest.current.format(v))],
        scales: {
          y: {
            range: (_u, _min, max) => [0, Math.max(max, minMax) * 1.1],
          },
        },
        ...(selectable
          ? { cursor: { drag: { x: true, y: false, setScale: false } } }
          : {}),
        hooks: {
          setCursor: [(u: uPlot) => setHover(u.cursor.idx ?? null)],
          ...(selectable
            ? {
                setSelect: [
                  (u: uPlot) => {
                    if (u.select.width < 3) return;
                    const from = u.posToVal(u.select.left, "x");
                    const to = u.posToVal(u.select.left + u.select.width, "x");
                    dragged = true;
                    u.setSelect(
                      { left: 0, top: 0, width: 0, height: 0 },
                      false,
                    );
                    latest.current.onRange?.(from, to);
                  },
                ],
                ready: [
                  (u: uPlot) => {
                    u.over.style.cursor = "crosshair";
                    u.over.addEventListener("click", () => {
                      // A drag ends with a click on the same element: it was already reported.
                      if (dragged) {
                        dragged = false;
                        return;
                      }
                      const idx = u.cursor.idx;
                      const x =
                        idx === null || idx === undefined
                          ? undefined
                          : u.data[0][idx];
                      if (x !== undefined) latest.current.onRange?.(x, x);
                    });
                  },
                ],
              }
            : {}),
        },
        series: [
          {},
          ...s0.map((s) => ({
            label: s.label,
            stroke: cssColor(s.color),
            width: 2,
            // A line needs two neighbouring values; markers keep a lone minute visible.
            points: { show: hasIsolatedPoint },
          })),
        ],
      },
      [x0, ...s0.map((s) => s.values)],
      el,
    );
    plotRef.current = plot;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width > 0) plot.setSize({ width, height });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [shape, scheme, height, minMax, selectable]);

  useEffect(() => {
    plotRef.current?.setData([xs, ...series.map((s) => s.values)]);
  }, [xs, series]);

  const id = testId ?? "chart";
  return (
    <div className="w-full space-y-1.5">
      <div
        ref={ref}
        role="img"
        aria-label={label}
        data-testid={id}
        data-points={xs.length}
        className="w-full"
      />
      <ChartLegend
        testId={`${id}-legend`}
        series={series}
        xs={xs}
        format={format}
        hover={hover}
      />
    </div>
  );
}

/**
 * The kit's legend for a uPlot chart: a swatch and the name of each series. While the pointer is
 * over the plot it also reads out the time and each series' value at that point.
 */
function ChartLegend({
  testId,
  series,
  xs,
  format,
  hover,
}: {
  testId: string;
  series: ChartSeries[];
  xs: number[];
  format: (value: number) => string;
  hover: number | null;
}) {
  const at = hover !== null ? xs[hover] : undefined;
  return (
    <ul
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
    >
      {series.map((s) => {
        const value = hover !== null ? s.values[hover] : undefined;
        return (
          <li key={s.label} className="flex items-center gap-1.5">
            <Swatch color={s.color} />
            {s.label}
            {value !== null && value !== undefined && (
              <span className="font-mono tabular-nums text-foreground">
                {format(value)}
              </span>
            )}
          </li>
        );
      })}
      {at !== undefined && (
        <li className="ml-auto font-mono tabular-nums">{hhmm(at * 1000)}</li>
      )}
    </ul>
  );
}
