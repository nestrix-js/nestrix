import type { RouteCompareRow, RouteStats } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { useMemo } from "react";
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { BarCell } from "@/components/kit/bar-cell";
import { BarChart } from "@/components/kit/bar-chart";
import { Chip } from "@/components/kit/chip";
import { Delta } from "@/components/kit/delta";
import { Chart } from "@/components/kit/line-chart";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/kit/skeletons";
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
import { getMeta, getRouteCompare, getRoutes } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser, stringParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import { routeDetailHref } from "@/views/route/route-detail";
import { ComparePanel } from "@/views/routes/compare-panel";
import { RouteHistogram } from "@/views/routes/route-histogram";
import {
  compareByKey,
  formatPerMinute,
  rowChange,
  summarizeRoutes,
  topByP95,
  windowChanges,
} from "@/views/routes/route-kpis";
import {
  chartData,
  describeMethod,
  describeRoute,
  formatErrorRate,
  routeKey,
  sortByCount,
  statisticsNote,
} from "@/views/routes/route-stats";

const WINDOWS = [
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
] as const;
const DEFAULT_WINDOW = 15;
const VIEWS = [
  ["routes", "Routes"],
  ["compare", "Compare"],
] as const;

// The selected route is part of the URL, so a link or a reload keeps it.
const parsers = {
  windowMinutes: routeWindowParser,
  method: stringParser({ maxLength: 16 }),
  route: stringParser({ maxLength: 512 }),
  // The Compare tab (P9-02): what is compared and which releases.
  view: parseAsStringLiteral(["routes", "compare"] as const),
  compare: parseAsStringLiteral(["window", "release"] as const),
  releaseA: stringParser({ maxLength: 255 }),
  releaseB: stringParser({ maxLength: 255 }),
};

const integer = (v: number) => String(Math.round(v));

function RouteCharts({
  stats,
  windowMinutes,
  service,
}: {
  stats: RouteStats;
  windowMinutes: number;
  service: string | undefined;
}) {
  const data = useMemo(() => chartData(stats), [stats]);
  const { label, note } = describeRoute(stats);
  return (
    <Section
      testId="route-detail"
      title={`${describeMethod(stats.method)} ${label}`}
      description={`${note ? `${note}; ` : ""}last ${windowMinutes} minutes, one point per minute; slowest request ${formatDuration(stats.maxMs)}`}
      source="counted before sampling"
      className="space-y-4"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Latency</h4>
          <Chart
            testId="chart-latency"
            label={`Latency percentiles of ${label}`}
            xs={data.xs}
            series={data.latency}
            format={formatDuration}
          />
        </div>
        <div className="space-y-1">
          <h4 className="text-sm font-medium">
            Requests and errors per minute
          </h4>
          <Chart
            testId="chart-traffic"
            label={`Requests and errors per minute of ${label}`}
            xs={data.xs}
            series={data.traffic}
            format={integer}
          />
        </div>
      </div>
      <RouteHistogram
        stats={stats}
        windowMinutes={windowMinutes}
        service={service}
        label={label}
      />
    </Section>
  );
}

function RouteRow({
  r,
  active,
  maxCount,
  maxP95,
  compareRow,
  onSelect,
}: {
  r: RouteStats;
  active: boolean;
  maxCount: number;
  maxP95: number;
  compareRow: RouteCompareRow | undefined;
  onSelect: () => void;
}) {
  const { label, note } = describeRoute(r);
  const change = rowChange(compareRow);
  return (
    <TableRow
      data-testid="route-row"
      data-selected={active}
      onClick={(e) => {
        // The route button and the Details link do their own thing.
        if ((e.target as Element).closest("a, button")) return;
        onSelect();
      }}
      className={cn("cursor-pointer", active && "bg-muted")}
    >
      <TableCell>
        <Chip className="font-mono">{describeMethod(r.method)}</Chip>
      </TableCell>
      <TableCell>
        <button
          type="button"
          aria-pressed={active}
          title={routeKey(r)}
          onClick={onSelect}
          className={cn(
            "font-mono underline-offset-4 hover:underline",
            note && "italic",
          )}
        >
          {label}
        </button>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </TableCell>
      <TableCell>
        <BarCell value={r.count} max={maxCount} label={String(r.count)} />
      </TableCell>
      <TableCell className="text-right">
        <Chip
          tone={r.errors > 0 ? "worse" : "neutral"}
          className="font-mono"
          title={`${r.errors} of ${r.count} requests failed (5xx or thrown)`}
        >
          {formatErrorRate(r.errors, r.count)}
        </Chip>
      </TableCell>
      <TableCell className="text-right font-mono">
        {formatDuration(r.p50Ms)}
      </TableCell>
      <TableCell>
        <BarCell
          value={r.p95Ms}
          max={maxP95}
          label={formatDuration(r.p95Ms)}
          color="--chart-2"
        />
      </TableCell>
      <TableCell className="text-right font-mono">
        {formatDuration(r.p99Ms)}
      </TableCell>
      <TableCell>
        <span className="flex justify-end">
          <TrendLine
            values={r.series.map((p) => p.count)}
            color="--chart-1"
            label={`Requests per minute of ${routeKey(r)}`}
            width={80}
            height={22}
            area
          />
        </span>
      </TableCell>
      <TableCell className="text-right">
        <Delta text={change.text} tone={change.tone} title={change.title} />
      </TableCell>
      <TableCell className="text-right">
        <Link
          to={routeDetailHref(r.method, r.route) as "/"}
          data-testid="route-details-link"
          aria-label={`Details of ${routeKey(r)}`}
          className="text-sm underline underline-offset-4"
        >
          Details
        </Link>
      </TableCell>
    </TableRow>
  );
}

export function RoutesPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const view = query.view ?? "routes";
  const [paused] = usePaused();

  const [service] = useService();
  const stats = useQuery({
    queryKey: ["routes", "stats", windowMinutes, service],
    queryFn: () => getRoutes({ windowMinutes, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    // Switching the window keeps the old table on screen until the new one arrives.
    placeholderData: keepPreviousData,
  });
  // Same key and function as the Compare tab's, so opening it reuses this answer.
  const compare = useQuery({
    queryKey: ["routes", "compare", "window", windowMinutes, service],
    queryFn: () => getRouteCompare({ windowMinutes, previous: 1, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    enabled: view === "routes",
  });
  // Same key and function as the header's, so this is the cached answer.
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const note = meta.data
    ? statisticsNote(meta.data.sampling, meta.data.mode)
    : null;

  const routes = useMemo(
    () => sortByCount(stats.data?.routes ?? []),
    [stats.data],
  );
  const summary = useMemo(
    () => summarizeRoutes(routes, windowMinutes),
    [routes, windowMinutes],
  );
  const changes = useMemo(() => windowChanges(compare.data), [compare.data]);
  const compareRows = useMemo(() => compareByKey(compare.data), [compare.data]);
  const top = useMemo(() => topByP95(routes), [routes]);
  const maxCount = Math.max(1, ...routes.map((r) => r.count));
  const maxP95 = Math.max(1, ...routes.map((r) => r.p95Ms));
  const selected =
    query.route === null
      ? undefined
      : routes.find(
          (r) =>
            r.route === query.route &&
            (query.method === null || r.method === query.method),
        );
  const shownWindow = stats.data?.windowMinutes ?? windowMinutes;
  const select = (r: RouteStats, active: boolean) =>
    void setQuery(
      active
        ? { route: null, method: null }
        : { route: r.route, method: r.method },
    );

  const worstParts = summary.worst
    ? formatDuration(summary.worst.p95Ms).split(" ")
    : null;

  return (
    <section className="space-y-6" aria-label="Routes">
      <PageHeader
        title="Routes"
        description="Traffic, errors and latency of every route"
        source="stats"
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
              onClick={() => void stats.refetch()}
            >
              <RefreshCw />
              Reload
            </Button>
          </>
        }
      />
      {note && (
        <p
          data-testid="statistics-note"
          className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          {note}
        </p>
      )}

      <div
        role="tablist"
        aria-label="Routes view"
        className="flex gap-4 border-b border-border"
      >
        {VIEWS.map(([id, name]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => void setQuery({ view: id === "routes" ? null : id })}
            className={cn(
              "-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors",
              view === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {name}
          </button>
        ))}
      </div>
      {view === "compare" && (
        <ComparePanel
          mode={query.compare ?? "window"}
          onMode={(mode) =>
            void setQuery({ compare: mode === "window" ? null : mode })
          }
          windowMinutes={windowMinutes}
          releaseA={query.releaseA}
          releaseB={query.releaseB}
          onReleases={(a, b) => void setQuery({ releaseA: a, releaseB: b })}
          service={service}
        />
      )}

      {view === "routes" && stats.isPending && (
        <>
          <SkeletonKpiStrip />
          <SkeletonChart heightClass="h-40" />
          <DataTableSkeleton columnCount={10} />
        </>
      )}
      {view === "routes" && stats.isError && stats.data === undefined && (
        <ErrorState
          title="Could not load route statistics."
          message={stats.error?.message}
          onRetry={() => void stats.refetch()}
        />
      )}
      {view === "routes" && stats.data !== undefined && (
        <>
          {routes.length > 0 && (
            <>
              <KpiStrip>
                <StatTile
                  testId="kpi-routes"
                  label="Routes"
                  value={String(summary.routes)}
                  unit={`with ${summary.requests.toLocaleString("en")} requests`}
                  source="counted before sampling"
                />
                <StatTile
                  testId="kpi-rate"
                  label="Requests per minute"
                  value={formatPerMinute(summary.requestsPerMinute)}
                  unit="req/min"
                  delta={changes.requests.text}
                  deltaTone={changes.requests.tone}
                  deltaTitle={changes.requests.title}
                  series={summary.requestSeries}
                  seriesColor="--chart-1"
                  seriesLabel={`Requests per minute over the last ${shownWindow} minutes`}
                  source="counted before sampling"
                />
                <StatTile
                  testId="kpi-error-rate"
                  label="Error rate"
                  value={
                    summary.errorRate === null
                      ? "—"
                      : formatErrorRate(summary.errors, summary.requests)
                  }
                  unit={`${summary.errors.toLocaleString("en")} of ${summary.requests.toLocaleString("en")}`}
                  delta={changes.errorRate.text}
                  deltaTone={changes.errorRate.tone}
                  deltaTitle={changes.errorRate.title}
                  series={summary.errorSeries}
                  seriesColor="--destructive"
                  seriesLabel={`Errors per minute over the last ${shownWindow} minutes`}
                  source="5xx or thrown · counted before sampling"
                />
                <StatTile
                  testId="kpi-worst-p95"
                  label="Worst p95"
                  value={worstParts?.[0] ?? "—"}
                  unit={worstParts?.[1]}
                  delta={changes.worstP95.text}
                  deltaTone={changes.worstP95.tone}
                  deltaTitle={changes.worstP95.title}
                  footer={
                    summary.worst ? (
                      <span
                        className="truncate font-mono text-xs"
                        title={routeKey(summary.worst)}
                      >
                        {describeMethod(summary.worst.method)}{" "}
                        {describeRoute(summary.worst).label}
                      </span>
                    ) : undefined
                  }
                  source="slowest route by p95"
                />
              </KpiStrip>
              <Section
                testId="card-top-p95"
                title="Slowest by p95"
                description={`Top ${top.length} by p95 over the last ${shownWindow} minutes`}
                source="counted before sampling"
              >
                <BarChart
                  orientation="horizontal"
                  testId="chart-top-p95"
                  barTestId="top-p95-bar"
                  labelWidthClass="w-28 sm:w-56"
                  max={Math.max(1, ...top.map((r) => r.p95Ms))}
                  label={`Routes by p95: ${top[0] ? `${routeKey(top[0])} is slowest at ${formatDuration(top[0].p95Ms)}` : "none"}`}
                  items={top.map((r) => ({
                    key: routeKey(r),
                    label: `${describeMethod(r.method)} ${describeRoute(r).label}`,
                    title: routeKey(r),
                    valueLabel: formatDuration(r.p95Ms),
                    segments: [{ value: r.p95Ms, color: "--chart-2" }],
                  }))}
                />
              </Section>
            </>
          )}
          {routes.length > 0 ? (
            <Section
              testId="card-routes"
              title="Route table"
              description="Busiest first; select a route for its charts"
              source="counted before sampling"
              flush
            >
              <Table
                data-testid="routes"
                containerClassName="max-h-[70vh]"
                className="min-w-[56rem]"
              >
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Method</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Error rate</TableHead>
                    <TableHead className="text-right">p50</TableHead>
                    <TableHead className="text-right">p95</TableHead>
                    <TableHead className="text-right">p99</TableHead>
                    <TableHead className="text-right">Trend</TableHead>
                    <TableHead
                      className="text-right"
                      title="p95 against the previous window"
                    >
                      p95 change
                    </TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Route detail</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {routes.map((r) => {
                    const active = selected === r;
                    return (
                      <RouteRow
                        key={routeKey(r)}
                        r={r}
                        active={active}
                        maxCount={maxCount}
                        maxP95={maxP95}
                        compareRow={compareRows.get(routeKey(r))}
                        onSelect={() => select(r, active)}
                      />
                    );
                  })}
                </TableBody>
              </Table>
            </Section>
          ) : (
            <EmptyState
              title={`No requests in the last ${shownWindow} minutes.`}
            >
              Routes appear here as the app handles requests.
            </EmptyState>
          )}
          {selected ? (
            <RouteCharts
              stats={selected}
              windowMinutes={shownWindow}
              service={service}
            />
          ) : (
            routes.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Select a route to see its latency and traffic over the last{" "}
                {shownWindow} minutes.
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
