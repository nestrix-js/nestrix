import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";

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
}

const cssColor = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
  "currentColor";

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
}: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const scheme = useColorScheme();
  const latest = useRef({ xs, series, format });
  latest.current = { xs, series, format };
  // The plot is rebuilt for these only.
  const shape = JSON.stringify(series.map((s) => [s.label, s.color]));

  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` and `scheme` stand for what the plot is built from; data and format are read through `latest`
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { xs: x0, series: s0 } = latest.current;
    const fmt = (v: number | null | undefined) =>
      v === null || v === undefined ? "-" : latest.current.format(v);
    const axis = {
      stroke: cssColor("--muted-foreground"),
      grid: { stroke: cssColor("--border"), width: 1 },
      ticks: { stroke: cssColor("--border"), width: 1 },
    };
    const plot = new uPlot(
      {
        width: el.clientWidth || 480,
        height,
        axes: [
          axis,
          {
            ...axis,
            size: 64,
            values: (_u, vals) => vals.map((v) => fmt(v)),
          },
        ],
        scales: {
          y: { range: (_u, _min, max) => [0, Math.max(max, 1) * 1.1] },
        },
        series: [
          {},
          ...s0.map((s) => ({
            label: s.label,
            stroke: cssColor(s.color),
            width: 2,
            // A line needs two neighbouring values; markers keep a lone minute visible.
            points: { show: hasIsolatedPoint },
            value: (_u: uPlot, v: number | null) => fmt(v),
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
  }, [shape, scheme, height]);

  useEffect(() => {
    plotRef.current?.setData([xs, ...series.map((s) => s.values)]);
  }, [xs, series]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      data-testid={testId ?? "chart"}
      data-points={xs.length}
      className="w-full"
    />
  );
}
