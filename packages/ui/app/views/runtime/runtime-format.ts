import type { RuntimeSample } from "@nestrix-js/protocol";

import type { ChartSeries } from "@/components/kit/line-chart";

export interface RuntimeCharts {
  /** Unix seconds. */
  xs: number[];
  eventLoop: ChartSeries[];
  memory: ChartSeries[];
  cpu: ChartSeries[];
  resources: ChartSeries[];
}

/** Columns for the four charts, one point per sample; a missing value leaves a gap. */
export function runtimeCharts(samples: RuntimeSample[]): RuntimeCharts {
  const col = (pick: (s: RuntimeSample) => number | null) => samples.map(pick);
  return {
    xs: samples.map((s) => s.timeUnixMs / 1000),
    eventLoop: [
      {
        label: "p50",
        color: "--chart-1",
        values: col((s) => s.eventLoopP50Ms),
      },
      {
        label: "p99",
        color: "--chart-2",
        values: col((s) => s.eventLoopP99Ms),
      },
      {
        label: "max",
        color: "--chart-3",
        values: col((s) => s.eventLoopMaxMs),
      },
    ],
    memory: [
      {
        label: "heap used",
        color: "--chart-1",
        values: col((s) => s.heapUsedBytes),
      },
      {
        label: "heap total",
        color: "--chart-2",
        values: col((s) => s.heapTotalBytes),
      },
      { label: "RSS", color: "--chart-3", values: col((s) => s.rssBytes) },
      {
        label: "external",
        color: "--muted-foreground",
        values: col((s) => s.externalBytes),
      },
    ],
    cpu: [
      {
        label: "user",
        color: "--chart-1",
        values: col((s) => s.cpuUserPercent),
      },
      {
        label: "system",
        color: "--chart-3",
        values: col((s) => s.cpuSystemPercent),
      },
    ],
    resources: [
      {
        label: "active handles",
        color: "--chart-1",
        values: col((s) => s.activeResources),
      },
    ],
  };
}

/** `812 KB`, `54.3 MB`, `1.20 GB`. */
export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(value < 10 ? 1 : 0)}%` : "-";
}

/** `45 s`, `12 min`, `3.5 h`, `2.1 d`. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

export const EVENT_LOOP_NOTE =
  "Event loop delay is how late the Node.js event loop runs a task it meant to run on time. It is measured every 20 ms and summarised per 10 s. A high p99 or max means something blocked the loop (heavy synchronous code, a long garbage collection), so every request waited. Process figures, not trace data: they are not sampled.";
