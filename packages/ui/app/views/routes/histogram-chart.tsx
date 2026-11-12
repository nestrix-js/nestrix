import type { HistogramBucket } from "@nestrix-js/protocol";
import { useEffect, useRef } from "react";
import uPlot from "uplot";

import { formatDuration } from "@/lib/format";

export interface Marker {
  label: string;
  /** A CSS custom property holding the colour. */
  color: string;
  /** Bucket index the marker sits on. */
  x: number;
}

interface Props {
  buckets: HistogramBucket[];
  markers: Marker[];
  label: string;
  /** Called with the bucket index of a click on a bar that holds requests. */
  onSelect: (index: number) => void;
  height?: number;
}

const cssColor = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
  "currentColor";

const tickLabel = (b: HistogramBucket | undefined) =>
  b === undefined
    ? ""
    : b.toMs === null
      ? `>${formatDuration(b.fromMs)}`
      : formatDuration(b.toMs);

/**
 * A uPlot bar chart of a latency histogram: one bar per bucket (x is the bucket index, the axis
 * names each bucket's upper bound), dashed lines for the percentiles, and a click on a bar that
 * holds requests calls `onSelect`. The plot is built once per colour scheme; data, markers and
 * the callback are read through a ref so polls only replace the data.
 */
export function HistogramChart({
  buckets,
  markers,
  label,
  onSelect,
  height = 200,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const latest = useRef({ buckets, markers, onSelect });
  latest.current = { buckets, markers, onSelect };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const axis = {
      stroke: cssColor("--muted-foreground"),
      grid: { stroke: cssColor("--border"), width: 1 },
      ticks: { stroke: cssColor("--border"), width: 1 },
    };
    const fill = cssColor("--chart-1");
    const plot = new uPlot(
      {
        width: el.clientWidth || 480,
        height,
        legend: { show: false },
        cursor: { drag: { x: false, y: false }, points: { show: false } },
        scales: {
          x: {
            time: false,
            range: () => [-0.5, latest.current.buckets.length - 0.5],
          },
          y: { range: (_u, _min, max) => [0, Math.max(max, 1) * 1.15] },
        },
        axes: [
          {
            ...axis,
            // Every fourth bucket: the bounds are log-spaced and crowd a narrow chart.
            splits: () =>
              latest.current.buckets.flatMap((_, i) =>
                i % 4 === 0 ? [i] : [],
              ),
            values: (_u, vals) =>
              vals.map((v) => tickLabel(latest.current.buckets[v])),
          },
          { ...axis, size: 48, values: (_u, vals) => vals.map(String) },
        ],
        series: [
          {},
          {
            label: "Requests",
            fill,
            stroke: fill,
            width: 0,
            paths: uPlot.paths.bars?.({ size: [0.9, 100] }),
            points: { show: false },
          },
        ],
        hooks: {
          draw: [
            (u) => {
              const ctx = u.ctx;
              const { top, height: h } = u.bbox;
              ctx.save();
              ctx.lineWidth = 2;
              ctx.setLineDash([6, 4]);
              ctx.font = `${12 * devicePixelRatio}px sans-serif`;
              let row = 0;
              for (const m of latest.current.markers) {
                const x = Math.round(u.valToPos(m.x, "x", true));
                ctx.strokeStyle = cssColor(m.color);
                ctx.fillStyle = cssColor(m.color);
                ctx.beginPath();
                ctx.moveTo(x, top);
                ctx.lineTo(x, top + h);
                ctx.stroke();
                ctx.fillText(
                  m.label,
                  x + 4 * devicePixelRatio,
                  top + (12 + row * 14) * devicePixelRatio,
                );
                row++;
              }
              ctx.restore();
            },
          ],
          ready: [
            (u) => {
              u.over.style.cursor = "pointer";
              u.over.addEventListener("click", (e) => {
                // x is the bucket index: the nearest whole number under the pointer.
                const left = e.clientX - u.over.getBoundingClientRect().left;
                const i = Math.round(u.posToVal(left, "x"));
                const data = u.data[1] as (number | null)[];
                if ((data[i] ?? 0) > 0) latest.current.onSelect(i);
              });
            },
          ],
        },
      },
      [
        latest.current.buckets.map((_, i) => i),
        latest.current.buckets.map((b) => b.count),
      ],
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
  }, [height]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `markers` are drawn from `latest`; a change redraws through setData
  useEffect(() => {
    plotRef.current?.setData([
      buckets.map((_, i) => i),
      buckets.map((b) => b.count),
    ]);
  }, [buckets, markers]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      data-testid="chart-histogram"
      data-buckets={buckets.length}
      className="w-full"
    />
  );
}
