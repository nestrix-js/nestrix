import type { HistogramBucket } from "@nestrix-js/protocol";
import { useEffect, useRef } from "react";
import uPlot from "uplot";

import { assignLabelRows } from "@/components/kit/chart-axis";
import {
  axisBase,
  cssColor,
  NO_LEGEND,
  valueAxis,
} from "@/components/kit/uplot-preset";
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

/** Rows of percentile labels above the plot, and the height they take (CSS px). */
const LABEL_ROWS = 2;
const LABEL_ROW_PX = 15;
const LABEL_PAD_PX = LABEL_ROWS * LABEL_ROW_PX + 4;

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
    const axis = axisBase();
    // A backdrop: the percentile lines carry the colour.
    const fill = cssColor("--chart-neutral");
    const plot = new uPlot(
      {
        width: el.clientWidth || 480,
        height,
        legend: NO_LEGEND,
        // Room above the plot for the percentile labels, so they never sit on their own line.
        padding: [LABEL_PAD_PX, null, null, null],
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
          valueAxis(String, 48),
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
              const dpr = devicePixelRatio;
              const { top, height: h, left, width } = u.bbox;
              ctx.save();
              ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
              ctx.textAlign = "center";
              const marks = latest.current.markers.map((m) => ({
                ...m,
                // valToPos is relative to the plot area; the canvas starts left of it.
                x: Math.round(left + u.valToPos(m.x, "x", true)),
              }));
              const rows = assignLabelRows(
                marks.map((m) => ({
                  x: m.x / dpr,
                  width: ctx.measureText(m.label).width / dpr,
                })),
                LABEL_ROWS,
              );
              const background = cssColor("--background");
              marks.forEach((m, i) => {
                const row = rows[i] ?? 0;
                const color = cssColor(m.color);
                // The label's baseline: row 0 is the one nearest the plot.
                const base = top - (4 + row * LABEL_ROW_PX) * dpr;
                ctx.setLineDash([6 * dpr, 4 * dpr]);
                ctx.lineWidth = 2 * dpr;
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.moveTo(m.x, base + 2 * dpr);
                ctx.lineTo(m.x, top + h);
                ctx.stroke();
                // Centred on the line, kept inside the canvas, with a halo against the bars.
                const half = ctx.measureText(m.label).width / 2 + 2 * dpr;
                const x = Math.min(
                  Math.max(m.x, half),
                  left + width + 8 * dpr - half,
                );
                ctx.setLineDash([]);
                ctx.lineJoin = "round";
                ctx.lineWidth = 4 * dpr;
                ctx.strokeStyle = background;
                ctx.strokeText(m.label, x, base - 2 * dpr);
                ctx.fillStyle = color;
                ctx.fillText(m.label, x, base - 2 * dpr);
              });
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
