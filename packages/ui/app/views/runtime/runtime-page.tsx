import type { RuntimeSample } from "@nestrix-js/protocol";
import { useQuery } from "@tanstack/react-query";
import { Activity, Info } from "lucide-react";
import { useMemo } from "react";

import { Chip } from "@/components/kit/chip";
import type { ChipTone } from "@/components/kit/format";
import { Chart, type ChartSeries } from "@/components/kit/line-chart";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/kit/skeletons";
import { KpiStrip, StatTile } from "@/components/kit/stat-tile";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { getMeta, getRuntime } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { cn } from "@/lib/utils";
import {
  cpuLevel,
  EVENT_LOOP_NOTE,
  formatMemory,
  formatMemoryAxis,
  formatPercent,
  formatUptime,
  heapLevel,
  type Level,
  levelLabel,
  loopLevel,
  present,
  runtimeCharts,
} from "@/views/runtime/runtime-format";

const SOURCE = "this process, not sampled traces";
const integer = (v: number) => String(Math.round(v));
const DASH = "-";

const levelTone: Record<Level, ChipTone> = {
  ok: "better",
  watch: "warn",
  high: "worse",
};
const levelColor: Record<Level, string> = {
  ok: "--chart-1",
  watch: "--warning",
  high: "--destructive",
};
const levelFill: Record<Level, string> = {
  ok: "bg-success",
  watch: "bg-warning",
  high: "bg-destructive",
};

/** A bar that fills to `fraction` (0 to 1) in the colour of its level, with words next to it. */
function Gauge({
  fraction,
  level,
  label,
}: {
  fraction: number;
  level: Level;
  label: string;
}) {
  const percent = Math.min(100, Math.max(0, fraction * 100));
  return (
    <div className="flex items-center gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: a <meter> cannot be styled to the dashboard's bars across browsers; the div carries the meter role and its values */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", levelFill[level])}
          style={{ width: `${percent}%` }}
        />
      </div>
      <Chip tone={levelTone[level]}>{levelLabel[level]}</Chip>
    </div>
  );
}

function Panel({
  id,
  title,
  description,
  xs,
  series,
  format,
}: {
  id: string;
  title: string;
  description: string;
  xs: number[];
  series: ChartSeries[];
  format: (v: number) => string;
}) {
  return (
    <Section
      testId={`panel-${id}`}
      title={title}
      description={description}
      source={SOURCE}
    >
      <Chart
        testId={`chart-${id}`}
        label={`${title} over the last hour`}
        xs={xs}
        series={series}
        format={format}
        height={190}
      />
    </Section>
  );
}

function Tiles({
  current,
  charts,
  uptimeSeconds,
  nodeVersion,
}: {
  current: RuntimeSample | null;
  charts: ReturnType<typeof runtimeCharts>;
  uptimeSeconds: number;
  nodeVersion: string;
}) {
  const p99 = current?.eventLoopP99Ms ?? null;
  const loop = p99 !== null ? loopLevel(p99) : null;
  const heap = current
    ? heapLevel(current.heapUsedBytes, current.heapTotalBytes)
    : null;
  const cpuNow = current
    ? current.cpuUserPercent + current.cpuSystemPercent
    : null;
  const cpu = cpuNow !== null ? cpuLevel(cpuNow) : null;
  return (
    <div className="space-y-4">
      <KpiStrip>
        <StatTile
          testId="tile-loop-p99"
          label="Event loop p99"
          value={p99 !== null ? formatDuration(p99) : DASH}
          series={present(charts.eventLoop[1]?.values ?? [])}
          seriesColor={levelColor[loop ?? "ok"]}
          seriesLabel="Event loop delay p99 over the last hour"
          source={
            current?.eventLoopP50Ms != null && current.eventLoopMaxMs != null
              ? `p50 ${formatDuration(current.eventLoopP50Ms)} · max ${formatDuration(current.eventLoopMaxMs)}`
              : "how late the loop runs a task"
          }
          footer={
            p99 !== null &&
            loop !== null && (
              <Gauge
                fraction={p99 / 100}
                level={loop}
                label="Event loop p99 against 100 ms"
              />
            )
          }
        />
        <StatTile
          testId="tile-heap"
          label="Heap used"
          value={current ? formatMemory(current.heapUsedBytes) : DASH}
          series={present(charts.memory[0]?.values ?? [])}
          seriesColor={levelColor[heap ?? "ok"]}
          seriesLabel="Heap used over the last hour"
          source={
            current
              ? `of ${formatMemory(current.heapTotalBytes)} V8 has allocated`
              : "V8 heap in use"
          }
          footer={
            current &&
            heap !== null && (
              <Gauge
                fraction={
                  current.heapTotalBytes > 0
                    ? current.heapUsedBytes / current.heapTotalBytes
                    : 0
                }
                level={heap}
                label="Heap used of the heap allocated"
              />
            )
          }
        />
        <StatTile
          testId="tile-rss"
          label="RSS"
          value={current ? formatMemory(current.rssBytes) : DASH}
          series={present(charts.memory[2]?.values ?? [])}
          seriesColor="--chart-1"
          seriesLabel="Resident set size over the last hour"
          source="memory the OS holds for the process"
        />
        <StatTile
          testId="tile-cpu"
          label="CPU (user + system)"
          value={cpuNow !== null ? formatPercent(cpuNow) : DASH}
          series={present(
            charts.cpu[0]?.values.map((u, i) => {
              const s = charts.cpu[1]?.values[i];
              return u === null || s === null || s === undefined ? null : u + s;
            }) ?? [],
          )}
          seriesColor={levelColor[cpu ?? "ok"]}
          seriesLabel="CPU over the last hour"
          source={
            current
              ? `user ${formatPercent(current.cpuUserPercent)} · system ${formatPercent(current.cpuSystemPercent)}`
              : "percent of one core"
          }
          footer={
            cpuNow !== null &&
            cpu !== null && (
              <Gauge
                fraction={cpuNow / 100}
                level={cpu}
                label="CPU against one full core"
              />
            )
          }
        />
      </KpiStrip>
      <KpiStrip>
        <StatTile
          testId="tile-external"
          label="External memory"
          value={current ? formatMemory(current.externalBytes) : DASH}
          source="buffers and C++ objects"
        />
        <StatTile
          testId="tile-handles"
          label="Active handles"
          value={
            current?.activeResources != null
              ? String(current.activeResources)
              : DASH
          }
          series={present(charts.resources[0]?.values ?? [])}
          seriesColor="--chart-1"
          seriesLabel="Active handles over the last hour"
          source="sockets, timers, files open"
        />
        <StatTile
          testId="tile-uptime"
          label="Process uptime"
          value={formatUptime(uptimeSeconds)}
        />
        <StatTile testId="tile-node" label="Node.js" value={nodeVersion} />
      </KpiStrip>
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
      <section aria-label="Runtime" className="space-y-6">
        <PageHeader
          title="Runtime"
          description="Event loop, memory and CPU of the running process"
          source={SOURCE}
        />
        <EmptyState
          testId="runtime-unavailable"
          icon={<Activity />}
          title="Runtime figures are not available here"
        >
          The runtime view shows one process, so it is available in an
          application's embedded dashboard. The standalone server has no
          per-process data.
        </EmptyState>
      </section>
    );
  }

  return (
    <section aria-label="Runtime" className="space-y-6">
      <PageHeader
        title="Runtime"
        description="Event loop, memory and CPU of this process, sampled every 10 seconds over the last 60 minutes"
        source={SOURCE}
      />
      {runtime.isError && (
        <ErrorState
          title="Could not load runtime data."
          message={runtime.error.message}
          onRetry={() => void runtime.refetch()}
        />
      )}
      {runtime.data === undefined && !runtime.isError && (
        <>
          <SkeletonKpiStrip />
          <div className="grid gap-4 md:grid-cols-2">
            <SkeletonChart heightClass="h-40" />
            <SkeletonChart heightClass="h-40" />
          </div>
        </>
      )}
      {runtime.data && (
        <>
          <Tiles
            current={runtime.data.current}
            charts={charts}
            uptimeSeconds={runtime.data.process.uptimeSeconds}
            nodeVersion={runtime.data.process.nodeVersion}
          />
          {runtime.data.samples.length === 0 ? (
            <EmptyState
              testId="runtime-empty"
              icon={<Activity />}
              title="Collecting the first sample"
            >
              The process is sampled every 10 seconds; the charts appear after
              the first one.
            </EmptyState>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Panel
                id="eventloop"
                title="Event loop delay"
                description="p50, p99 and max per 10 seconds"
                xs={charts.xs}
                series={charts.eventLoop}
                format={formatDuration}
              />
              <Panel
                id="memory"
                title="Memory"
                description="Heap, RSS and external memory"
                xs={charts.xs}
                series={charts.memory}
                format={formatMemoryAxis}
              />
              <Panel
                id="cpu"
                title="CPU, percent of one core"
                description="User and system time"
                xs={charts.xs}
                series={charts.cpu}
                format={formatPercent}
              />
              <Panel
                id="handles"
                title="Active handles"
                description="Sockets, timers and open files"
                xs={charts.xs}
                series={charts.resources}
                format={integer}
              />
            </div>
          )}
          <aside
            data-testid="runtime-note"
            className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground"
          >
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{EVENT_LOOP_NOTE}</p>
          </aside>
        </>
      )}
    </section>
  );
}
