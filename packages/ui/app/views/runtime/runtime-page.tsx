import type { RuntimeSample } from "@nestrix-js/protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { Chart, type ChartSeries } from "@/components/chart";
import { getMeta, getRuntime } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import {
  EVENT_LOOP_NOTE,
  formatMemory,
  formatPercent,
  formatUptime,
  runtimeCharts,
} from "@/views/runtime/runtime-format";

const integer = (v: number) => String(Math.round(v));

function Tile({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  return (
    <div
      data-testid={`tile-${id}`}
      className="rounded-lg border border-border p-3"
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Panel({
  id,
  title,
  xs,
  series,
  format,
}: {
  id: string;
  title: string;
  xs: number[];
  series: ChartSeries[];
  format: (v: number) => string;
}) {
  return (
    <div className="space-y-1 rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      <Chart
        testId={`chart-${id}`}
        label={title}
        xs={xs}
        series={series}
        format={format}
      />
    </div>
  );
}

function Tiles({
  current,
  uptimeSeconds,
  nodeVersion,
}: {
  current: RuntimeSample | null;
  uptimeSeconds: number;
  nodeVersion: string;
}) {
  const dash = "-";
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Tile
        id="loop-p99"
        label="Event loop p99"
        value={
          current?.eventLoopP99Ms != null
            ? formatDuration(current.eventLoopP99Ms)
            : dash
        }
      />
      <Tile
        id="heap"
        label="Heap used"
        value={current ? formatMemory(current.heapUsedBytes) : dash}
      />
      <Tile
        id="rss"
        label="RSS"
        value={current ? formatMemory(current.rssBytes) : dash}
      />
      <Tile
        id="cpu"
        label="CPU (user + system)"
        value={
          current
            ? formatPercent(current.cpuUserPercent + current.cpuSystemPercent)
            : dash
        }
      />
      <Tile
        id="external"
        label="External memory"
        value={current ? formatMemory(current.externalBytes) : dash}
      />
      <Tile
        id="handles"
        label="Active handles"
        value={
          current?.activeResources != null
            ? String(current.activeResources)
            : dash
        }
      />
      <Tile
        id="uptime"
        label="Process uptime"
        value={formatUptime(uptimeSeconds)}
      />
      <Tile id="node" label="Node.js" value={nodeVersion} />
    </div>
  );
}

export function RuntimePage() {
  const [paused] = usePaused();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const available = meta.data?.runtime?.available === true;
  const runtime = useQuery({
    queryKey: ["runtime"],
    queryFn: getRuntime,
    enabled: available,
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
  });
  const samples = runtime.data?.samples;
  const charts = useMemo(() => runtimeCharts(samples ?? []), [samples]);

  if (meta.data !== undefined && !available) {
    return (
      <section aria-label="Runtime" className="space-y-2">
        <h2 className="text-lg font-semibold">Runtime</h2>
        <p
          data-testid="runtime-unavailable"
          className="text-sm text-muted-foreground"
        >
          The runtime view shows one process, so it is available in an
          application's embedded dashboard. The standalone server has no
          per-process data.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Runtime" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Runtime</h2>
        <p className="text-xs text-muted-foreground">
          This process, sampled every 10 seconds, last 60 minutes.
        </p>
      </div>
      {runtime.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load runtime data.
        </p>
      )}
      {runtime.data && (
        <>
          <Tiles
            current={runtime.data.current}
            uptimeSeconds={runtime.data.process.uptimeSeconds}
            nodeVersion={runtime.data.process.nodeVersion}
          />
          {runtime.data.samples.length === 0 && (
            <p
              data-testid="runtime-empty"
              className="text-sm text-muted-foreground"
            >
              Collecting the first sample (every 10 seconds).
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Panel
              id="eventloop"
              title="Event loop delay"
              xs={charts.xs}
              series={charts.eventLoop}
              format={formatDuration}
            />
            <Panel
              id="memory"
              title="Memory"
              xs={charts.xs}
              series={charts.memory}
              format={formatMemory}
            />
            <Panel
              id="cpu"
              title="CPU, percent of one core"
              xs={charts.xs}
              series={charts.cpu}
              format={formatPercent}
            />
            <Panel
              id="handles"
              title="Active handles"
              xs={charts.xs}
              series={charts.resources}
              format={integer}
            />
          </div>
          <p
            data-testid="runtime-note"
            className="text-xs text-muted-foreground"
          >
            {EVENT_LOOP_NOTE}
          </p>
        </>
      )}
    </section>
  );
}
