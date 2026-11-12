import type { TraceTimelineResponse } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";

import { Button } from "@/components/ui/button";
import { getTimeline, type QueryParams } from "@/lib/api";
import { pollInterval, usePaused } from "@/lib/live";
import {
  formatClock,
  rangeOfBuckets,
  type TimeRange,
} from "@/views/requests/timeline-range";

const WINDOWS = [15, 60] as const;
/** A drag shorter than this many pixels is a click. */
const MIN_DRAG_PX = 4;
const HEIGHT = 96;

const cssColor = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
  "currentColor";

const total = (b: TraceTimelineResponse["buckets"][number]) =>
  b.ok + b.clientError + b.serverError;

/** Stacked series for uPlot: each is a running total, drawn largest first so the smaller ones overlay it. */
function stack(data: TraceTimelineResponse): (number | null)[][] {
  const xs = data.buckets.map(
    (b) => (b.startUnixMs + data.bucketMs / 2) / 1000,
  );
  return [
    xs,
    data.buckets.map(total),
    data.buckets.map((b) => b.clientError + b.serverError),
    data.buckets.map((b) => b.serverError),
  ];
}

/** Filters of the request list that the timeline understands (it has no time range of its own). */
export type TimelineFilters = QueryParams;

/**
 * Sampled requests per bucket, split by outcome, above the request list. Dragging over the chart,
 * or clicking a bar, sets the list's time range through `onRange`.
 */
export function RequestTimeline({
  filters,
  range,
  onRange,
}: {
  filters: TimelineFilters;
  range: TimeRange | null;
  onRange: (range: TimeRange | null) => void;
}) {
  const [windowMinutes, setWindowMinutes] = useState<number>(WINDOWS[0]);
  const [paused] = usePaused();
  const timeline = useQuery({
    queryKey: ["timeline", windowMinutes, filters],
    queryFn: () => getTimeline({ windowMinutes, ...filters }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const data = timeline.data;

  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const latest = useRef({ data, onRange });
  latest.current = { data, onRange };
  const dragged = useRef(false);

  // The plot exists once the first answer has arrived; later answers only replace its data.
  const ready = data !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ready` and `windowMinutes` stand for what the plot is built from; data and callbacks are read through `latest`
  useEffect(() => {
    const el = hostRef.current;
    const first = latest.current.data;
    if (!el || !first) return;
    const bars = uPlot.paths.bars?.({ size: [0.9, 64], align: 0 });
    const axis = {
      stroke: cssColor("--muted-foreground"),
      grid: { stroke: cssColor("--border"), width: 1 },
      ticks: { stroke: cssColor("--border"), width: 1 },
    };
    const fill = (name: string) => cssColor(name);
    const plot = new uPlot(
      {
        width: el.clientWidth || 480,
        height: HEIGHT,
        legend: { show: false },
        cursor: {
          drag: { x: true, y: false, setScale: false },
          points: { show: false },
        },
        select: { show: true, left: 0, top: 0, width: 0, height: 0 },
        axes: [
          { ...axis, size: 24 },
          { ...axis, size: 36, splits: (_u, _a, min, max) => [min, max] },
        ],
        scales: {
          x: {
            time: true,
            // The whole window, so every bar is inside it and the edges are bucket edges.
            range: () => {
              const d = latest.current.data;
              return d
                ? [
                    d.fromUnixMs / 1000,
                    (d.fromUnixMs + d.buckets.length * d.bucketMs) / 1000,
                  ]
                : [0, 1];
            },
          },
          y: { range: (_u, _min, max) => [0, Math.max(max, 1) * 1.1] },
        },
        series: [
          {},
          {
            label: "ok",
            stroke: fill("--chart-2"),
            fill: fill("--chart-2"),
            paths: bars,
          },
          {
            label: "4xx",
            stroke: fill("--warning"),
            fill: fill("--warning"),
            paths: bars,
          },
          {
            label: "5xx or error",
            stroke: fill("--chart-3"),
            fill: fill("--chart-3"),
            paths: bars,
          },
        ],
        hooks: {
          setSelect: [
            (u) => {
              const current = latest.current.data;
              if (!current || u.select.width < MIN_DRAG_PX) return;
              dragged.current = true;
              const from = u.posToVal(u.select.left, "x") * 1000;
              const to = u.posToVal(u.select.left + u.select.width, "x") * 1000;
              u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
              latest.current.onRange(
                rangeOfBuckets(
                  from,
                  to,
                  current.fromUnixMs,
                  current.bucketMs,
                  current.buckets.length,
                ),
              );
            },
          ],
        },
      },
      stack(first) as uPlot.AlignedData,
      el,
    );
    plotRef.current = plot;
    const onClick = () => {
      // A drag ends in a click event too; it has been handled by `setSelect`.
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      const current = latest.current.data;
      const idx = plot.cursor.idx;
      if (!current || idx === null || idx === undefined) return;
      const bucket = current.buckets[idx];
      if (!bucket || total(bucket) === 0) return;
      latest.current.onRange(
        rangeOfBuckets(
          bucket.startUnixMs,
          bucket.startUnixMs,
          current.fromUnixMs,
          current.bucketMs,
          current.buckets.length,
        ),
      );
    };
    plot.over.addEventListener("click", onClick);
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width > 0) plot.setSize({ width, height: HEIGHT });
    });
    observer.observe(el);
    return () => {
      plot.over.removeEventListener("click", onClick);
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [ready, windowMinutes]);

  useEffect(() => {
    if (data) plotRef.current?.setData(stack(data) as uPlot.AlignedData);
  }, [data]);

  const sampled = data?.buckets.reduce((n, b) => n + total(b), 0) ?? 0;
  return (
    <div
      className="space-y-2 rounded-lg border border-border p-3"
      data-testid="timeline-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Requests over time, from sampled traces
          {data && ` (${sampled} in ${data.windowMinutes} min)`}.{" "}
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-2 rounded-sm bg-[var(--chart-2)]" />{" "}
            ok
          </span>{" "}
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-2 rounded-sm bg-warning" /> 4xx
          </span>{" "}
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-2 rounded-sm bg-[var(--chart-3)]" />{" "}
            5xx or error
          </span>
          . Drag or click to filter the list by time.
        </span>
        <span className="flex items-center gap-1">
          {range && (
            <Button
              size="sm"
              variant="outline"
              data-testid="timeline-range"
              onClick={() => onRange(null)}
            >
              {formatClock(range.fromUnixMs)} to {formatClock(range.toUnixMs)}:
              clear
            </Button>
          )}
          <fieldset
            className="flex items-center gap-1"
            aria-label="Timeline window"
          >
            {WINDOWS.map((minutes) => (
              <Button
                key={minutes}
                size="sm"
                variant={windowMinutes === minutes ? "default" : "outline"}
                aria-pressed={windowMinutes === minutes}
                onClick={() => setWindowMinutes(minutes)}
              >
                {minutes} min
              </Button>
            ))}
          </fieldset>
        </span>
      </div>
      {timeline.isError && data === undefined && (
        <p role="alert" className="text-sm text-destructive">
          Could not load the timeline: {timeline.error?.message}
        </p>
      )}
      <div
        ref={hostRef}
        role="img"
        aria-label="Sampled requests per time bucket, by outcome"
        data-testid="timeline"
        data-buckets={data?.buckets.length ?? 0}
        className="w-full"
      />
    </div>
  );
}
