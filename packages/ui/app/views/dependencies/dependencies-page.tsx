import type { DependencyStats, MapNodeKind } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Box,
  Database,
  Globe,
  ListOrdered,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useQueryStates } from "nuqs";
import { useMemo } from "react";

import { AreaChart } from "@/components/kit/area-chart";
import { BarCell } from "@/components/kit/bar-cell";
import { Chip } from "@/components/kit/chip";
import { Delta } from "@/components/kit/delta";
import { Swatch } from "@/components/kit/donut";
import { compactNumber } from "@/components/kit/format";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SegmentedControl } from "@/components/kit/segmented-control";
import {
  SkeletonChart,
  SkeletonKpiStrip,
  SkeletonList,
} from "@/components/kit/skeletons";
import { KpiStrip, StatTile } from "@/components/kit/stat-tile";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { TrendLine } from "@/components/kit/trend-line";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDependencies, getMeta } from "@/lib/api";
import { formatDuration, STANDALONE_STATISTICS_NOTE } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser, stringParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import {
  dependencyChanges,
  rowP95Change,
} from "@/views/dependencies/dependency-changes";
import { filterByName } from "@/views/dependencies/dependency-filter";
import {
  callsSeries,
  dependencyHealth,
  formatErrorRate,
  type Health,
  healthLabel,
  healthTone,
} from "@/views/dependencies/dependency-health";

const WINDOWS = [
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
] as const;
const DEFAULT_WINDOW = 15;
const CARDS = 8;
const CHART_TOP = 4;
const parsers = {
  windowMinutes: routeWindowParser,
  // From a finding on the route page: the dependency's name as this page shows it.
  name: stringParser({ maxLength: 256 }),
};

const KIND_LABEL: Record<MapNodeKind, string> = {
  app: "app",
  database: "database",
  cache: "cache",
  http: "HTTP service",
  queue: "queue",
  other: "other",
};

const KIND_ICON: Record<MapNodeKind, typeof Database> = {
  app: Box,
  database: Database,
  cache: Zap,
  http: Globe,
  queue: ListOrdered,
  other: Box,
};

const SERIES_COLORS = ["--chart-1", "--chart-2", "--chart-4", "--chart-5"];
const OTHER_COLOR = "--muted-foreground";
const colorAt = (i: number) => SERIES_COLORS[i] ?? OTHER_COLOR;

const healthTrend: Record<Health, string> = {
  healthy: "--chart-1",
  degraded: "--warning",
  failing: "--destructive",
};
const healthDot: Record<Health, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  failing: "bg-destructive",
};

/** The target's name: a link to the trace of its slowest call when there is one. */
function TargetName({
  d,
  className,
}: {
  d: DependencyStats;
  className?: string;
}) {
  return d.exampleTraceId !== undefined ? (
    <Link
      to="/traces/$traceId"
      params={{ traceId: d.exampleTraceId }}
      className={cn("underline-offset-2 hover:underline", className)}
      title="Open the trace of the slowest call"
    >
      {d.name}
    </Link>
  ) : (
    <span className={className}>{d.name}</span>
  );
}

function HealthCard({
  d,
  bucketMinutes,
}: {
  d: DependencyStats;
  bucketMinutes: number;
}) {
  const health = dependencyHealth(d);
  const Icon = KIND_ICON[d.kind] ?? Box;
  return (
    <div
      data-testid="dependency-card"
      data-health={health}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4"
          >
            <Icon />
          </span>
          <div className="min-w-0">
            <TargetName d={d} className="block truncate text-sm font-medium" />
            <span className="text-xs text-muted-foreground">
              {KIND_LABEL[d.kind] ?? d.kind}
            </span>
          </div>
        </div>
        <Chip
          tone={healthTone[health]}
          icon={
            <span className={cn("size-1.5 rounded-full", healthDot[health])} />
          }
        >
          {healthLabel[health]}
        </Chip>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">p95</dt>
          <dd className="font-mono text-sm tabular-nums">
            {formatDuration(d.p95Ms)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Errors</dt>
          <dd
            className={cn(
              "font-mono text-sm tabular-nums",
              d.errors > 0 && "text-destructive-text",
            )}
          >
            {formatErrorRate(d)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Calls</dt>
          <dd className="font-mono text-sm tabular-nums">
            {compactNumber(d.calls)}
          </dd>
        </div>
      </dl>
      <TrendLine
        values={d.series.map((p) => p.p95Ms)}
        color={healthTrend[health]}
        label={`p95 per ${bucketMinutes} min for ${d.name}`}
        width={200}
        height={32}
        area
        stretch
      />
    </div>
  );
}

/** A trend as a table cell; the wrapper carries what the tests and readers need (`data-points`). */
function CellTrend({
  values,
  label,
  color,
}: {
  values: number[];
  label: string;
  color: string;
}) {
  return (
    <span data-testid="sparkline" data-points={values.length}>
      <TrendLine values={values} color={color} label={label} />
    </span>
  );
}

export function DependenciesPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const navigate = useNavigate();
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const [paused] = usePaused();
  const [service] = useService();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const standalone = meta.data?.mode === "standalone";

  const deps = useQuery({
    queryKey: ["dependencies", windowMinutes, service],
    queryFn: () => getDependencies({ windowMinutes, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  // Most total time first; the server sorts the same way, this keeps it true for any answer.
  const rows = useMemo(
    () =>
      filterByName(deps.data?.dependencies ?? [], query.name).sort(
        (a, b) => b.totalMs - a.totalMs || (a.id < b.id ? -1 : 1),
      ),
    [deps.data, query.name],
  );
  const shownWindow = deps.data?.windowMinutes ?? windowMinutes;
  const bucketMinutes = (deps.data?.bucketMs ?? 60_000) / 60_000;

  const totals = useMemo(() => {
    const calls = rows.reduce((sum, d) => sum + d.calls, 0);
    const errors = rows.reduce((sum, d) => sum + d.errors, 0);
    const slowest = rows.reduce<DependencyStats | null>(
      (best, d) => (best === null || d.p95Ms > best.p95Ms ? d : best),
      null,
    );
    const buckets = Math.max(0, ...rows.map((d) => d.series.length));
    const perBucket = Array.from({ length: buckets }, (_, i) =>
      rows.reduce((sum, d) => sum + (d.series[i]?.calls ?? 0), 0),
    );
    return { calls, errors, slowest, perBucket };
  }, [rows]);
  const chartSeries = useMemo(() => callsSeries(rows, CHART_TOP), [rows]);
  const maxTotal = Math.max(1, ...rows.map((d) => d.totalMs));
  const changes = dependencyChanges(deps.data, rows, query.name !== null);

  return (
    <section className="space-y-6" aria-label="Dependencies">
      <PageHeader
        title="Dependencies"
        description="What the app calls: databases, caches, HTTP services and queues"
        source="traces"
        controls={
          <>
            <SegmentedControl
              label="Time window"
              options={WINDOWS}
              value={windowMinutes}
              onChange={(minutes) =>
                void setQuery({
                  windowMinutes: minutes === DEFAULT_WINDOW ? null : minutes,
                })
              }
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label="Reload"
              onClick={() => void deps.refetch()}
            >
              <RefreshCw />
              Reload
            </Button>
          </>
        }
      />
      <p
        data-testid="dependencies-note"
        className="text-xs text-muted-foreground"
      >
        Built from sampled traces: calls, error rates and percentiles describe
        the traces in the store, not every call. Trends use {bucketMinutes}
        -minute buckets.
        {standalone && ` ${STANDALONE_STATISTICS_NOTE}`}
      </p>

      {query.name !== null && (
        <div
          data-testid="dependency-filter"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-muted-foreground">Filtered by dependency</span>
          <code className="rounded bg-secondary px-2 py-0.5 text-xs">
            {query.name}
          </code>
          <Button
            size="sm"
            variant="outline"
            data-testid="clear-dependency-filter"
            onClick={() => void setQuery({ name: null })}
          >
            Clear
          </Button>
        </div>
      )}

      {deps.isPending && (
        <>
          <SkeletonKpiStrip />
          <SkeletonChart heightClass="h-40" />
          <SkeletonList rows={5} />
        </>
      )}
      {deps.isError && deps.data === undefined && (
        <ErrorState
          title="Could not load dependencies."
          message={deps.error?.message}
          onRetry={() => void deps.refetch()}
        />
      )}
      {deps.data !== undefined &&
        (rows.length === 0 ? (
          <EmptyState testId="dependencies-empty" title="No outbound calls">
            {query.name !== null
              ? `No calls to ${query.name} in the last ${shownWindow} minutes.`
              : `No outbound calls in the last ${shownWindow} minutes. Databases, caches, HTTP services and queues the app calls appear here as it handles requests.`}
          </EmptyState>
        ) : (
          <>
            <KpiStrip>
              <StatTile
                testId="kpi-dependencies"
                label="Dependencies"
                value={String(rows.length)}
                unit={`in ${shownWindow} min`}
                delta={changes.dependencies.text}
                deltaTone={changes.dependencies.tone}
                deltaTitle={changes.dependencies.title}
                source="from sampled traces"
              />
              <StatTile
                testId="kpi-calls"
                label="Outbound calls"
                value={compactNumber(totals.calls)}
                delta={changes.calls.text}
                deltaTone={changes.calls.tone}
                deltaTitle={changes.calls.title}
                series={totals.perBucket}
                seriesColor="--chart-1"
                seriesLabel={`Calls per ${bucketMinutes} min across all dependencies`}
                source="from sampled traces"
              />
              <StatTile
                testId="kpi-error-rate"
                label="Error rate"
                value={
                  totals.calls > 0
                    ? formatErrorRate({
                        errors: totals.errors,
                        errorRate: totals.errors / totals.calls,
                      })
                    : "—"
                }
                unit={`${totals.errors.toLocaleString("en")} of ${totals.calls.toLocaleString("en")}`}
                delta={changes.errorRate.text}
                deltaTone={changes.errorRate.tone}
                deltaTitle={changes.errorRate.title}
                source="from sampled traces"
              />
              <StatTile
                testId="kpi-slowest"
                label="Slowest p95"
                value={
                  totals.slowest ? formatDuration(totals.slowest.p95Ms) : "—"
                }
                delta={changes.slowest.text}
                deltaTone={changes.slowest.tone}
                deltaTitle={changes.slowest.title}
                footer={
                  totals.slowest && (
                    <span className="truncate font-mono text-xs">
                      {totals.slowest.name}
                    </span>
                  )
                }
                source="from sampled traces"
              />
            </KpiStrip>

            <div
              data-testid="dependency-cards"
              className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            >
              {rows.slice(0, CARDS).map((d) => (
                <HealthCard key={d.id} d={d} bucketMinutes={bucketMinutes} />
              ))}
            </div>
            {rows.length > CARDS && (
              <p className="-mt-3 text-xs text-muted-foreground">
                {`Cards show the ${CARDS} dependencies with the most total time; the table lists all ${rows.length}.`}
              </p>
            )}

            {chartSeries.length > 0 && deps.data && (
              <Section
                testId="calls-chart"
                title="Calls over time"
                description={`Per ${bucketMinutes}-minute bucket, stacked by dependency`}
                source="from sampled traces"
              >
                <AreaChart
                  testId="calls-area"
                  stacked
                  heightClass="h-48"
                  fromUnixMs={deps.data.fromUnixMs}
                  toUnixMs={deps.data.toUnixMs}
                  format={compactNumber}
                  label={`Calls per ${bucketMinutes} minutes by dependency; ${chartSeries[0]?.label} makes the most calls`}
                  series={chartSeries.map((s, i) => ({
                    id: s.id,
                    label: s.label,
                    values: s.values,
                    color: s.id === "other" ? OTHER_COLOR : colorAt(i),
                  }))}
                />
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {chartSeries.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-1.5">
                      <Swatch
                        color={s.id === "other" ? OTHER_COLOR : colorAt(i)}
                      />
                      {s.label}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section
              testId="dependencies-section"
              title="All dependencies"
              description="Most total time first; the name opens the slowest call's trace"
              source="from sampled traces"
              flush
            >
              <Table data-testid="dependencies">
                <TableHeader>
                  <TableRow className="border-border">
                    <TableHead>Target</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                    <TableHead className="text-right">p50</TableHead>
                    <TableHead className="text-right">p95</TableHead>
                    <TableHead className="text-right">Total time</TableHead>
                    <TableHead>Calls trend</TableHead>
                    <TableHead>p95 trend</TableHead>
                    <TableHead className="text-right">p95 change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => {
                    const health = dependencyHealth(d);
                    const traceId = d.exampleTraceId;
                    return (
                      <TableRow
                        key={d.id}
                        data-testid="dependency-row"
                        className={cn(
                          "border-border",
                          traceId !== undefined && "cursor-pointer",
                        )}
                        onClick={(e) => {
                          if (
                            traceId === undefined ||
                            (e.target as Element).closest("a,button")
                          ) {
                            return;
                          }
                          void navigate({
                            to: "/traces/$traceId",
                            params: { traceId },
                          });
                        }}
                      >
                        <TableCell>
                          <div className="flex flex-col">
                            <TargetName d={d} className="font-medium" />
                            <span className="text-xs text-muted-foreground">
                              {KIND_LABEL[d.kind] ?? d.kind}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Chip tone={healthTone[health]}>
                            {healthLabel[health]}
                          </Chip>
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {d.calls}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono tabular-nums",
                            d.errors > 0 && "text-destructive-text",
                          )}
                        >
                          {d.errors} ({formatErrorRate(d)})
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatDuration(d.p50Ms)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatDuration(d.p95Ms)}
                        </TableCell>
                        <TableCell>
                          <BarCell
                            value={d.totalMs}
                            max={maxTotal}
                            label={formatDuration(d.totalMs)}
                            color="--chart-1"
                          />
                        </TableCell>
                        <TableCell>
                          <CellTrend
                            values={d.series.map((p) => p.calls)}
                            label={`Calls per ${bucketMinutes} min for ${d.name}`}
                            color="--chart-1"
                          />
                        </TableCell>
                        <TableCell>
                          <CellTrend
                            values={d.series.map((p) => p.p95Ms)}
                            label={`p95 per ${bucketMinutes} min for ${d.name}`}
                            color="--warning"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          {(() => {
                            const c = rowP95Change(d, deps.data);
                            return (
                              <Delta
                                text={c.text}
                                tone={c.tone}
                                title={c.title}
                              />
                            );
                          })()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Section>
          </>
        ))}
    </section>
  );
}
