import type { RouteStats } from "@nestrix/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useMemo } from "react";

import { Chart } from "@/components/chart";
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getMeta, getRoutes } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser, stringParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import {
  chartData,
  describeMethod,
  describeRoute,
  formatErrorRate,
  routeKey,
  sortByCount,
  statisticsNote,
} from "@/views/routes/route-stats";

const WINDOWS = [15, 60] as const;
const DEFAULT_WINDOW = 15;

// The selected route is part of the URL, so a link or a reload keeps it.
const parsers = {
  windowMinutes: routeWindowParser,
  method: stringParser({ maxLength: 16 }),
  route: stringParser({ maxLength: 512 }),
};

const integer = (v: number) => String(Math.round(v));

function RouteCharts({
  stats,
  windowMinutes,
}: {
  stats: RouteStats;
  windowMinutes: number;
}) {
  const data = useMemo(() => chartData(stats), [stats]);
  const { label, note } = describeRoute(stats);
  return (
    <div
      data-testid="route-detail"
      className="space-y-4 rounded-lg border border-border p-4"
    >
      <div>
        <h3 className="font-mono text-sm font-semibold">
          {describeMethod(stats.method)} {label}
        </h3>
        <p className="text-xs text-muted-foreground">
          {note ? `${note}; ` : ""}last {windowMinutes} minutes, one point per
          minute; slowest request {formatDuration(stats.maxMs)}
        </p>
      </div>
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
    </div>
  );
}

export function RoutesPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
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
  // Same key and function as the header's, so this is the cached answer.
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const note = meta.data
    ? statisticsNote(meta.data.sampling, meta.data.mode)
    : null;

  const routes = useMemo(
    () => sortByCount(stats.data?.routes ?? []),
    [stats.data],
  );
  const selected =
    query.route === null
      ? undefined
      : routes.find(
          (r) =>
            r.route === query.route &&
            (query.method === null || r.method === query.method),
        );
  const shownWindow = stats.data?.windowMinutes ?? windowMinutes;

  return (
    <section className="space-y-4" aria-label="Routes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Routes</h2>
        <div className="flex items-center gap-2">
          <fieldset
            className="flex items-center gap-1"
            aria-label="Time window"
          >
            {WINDOWS.map((minutes) => (
              <Button
                key={minutes}
                size="sm"
                variant={windowMinutes === minutes ? "default" : "outline"}
                aria-pressed={windowMinutes === minutes}
                onClick={() =>
                  void setQuery({
                    windowMinutes: minutes === DEFAULT_WINDOW ? null : minutes,
                  })
                }
              >
                {minutes} min
              </Button>
            ))}
          </fieldset>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Reload"
            onClick={() => void stats.refetch()}
          >
            <RefreshCw />
            Reload
          </Button>
        </div>
      </div>
      {note && (
        <p
          data-testid="statistics-note"
          className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
        >
          {note}
        </p>
      )}

      {stats.isPending && <DataTableSkeleton columnCount={7} />}
      {stats.isError && stats.data === undefined && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not load route statistics.</p>
          <p className="text-sm text-muted-foreground">
            {stats.error?.message}
          </p>
          <Button variant="outline" onClick={() => void stats.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {stats.data !== undefined && (
        <>
          <div className="rounded-lg border border-border">
            <Table data-testid="routes">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Method</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Error rate</TableHead>
                  <TableHead className="text-right">p50</TableHead>
                  <TableHead className="text-right">p95</TableHead>
                  <TableHead className="text-right">p99</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.length > 0 ? (
                  routes.map((r) => {
                    const { label, note: routeNote } = describeRoute(r);
                    const active = selected === r;
                    return (
                      <TableRow
                        key={routeKey(r)}
                        data-testid="route-row"
                        data-selected={active}
                        className={cn(active && "bg-muted")}
                      >
                        <TableCell>
                          <Badge variant="outline" className="font-mono">
                            {describeMethod(r.method)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            aria-pressed={active}
                            title={routeKey(r)}
                            onClick={() =>
                              void setQuery(
                                active
                                  ? { route: null, method: null }
                                  : { route: r.route, method: r.method },
                              )
                            }
                            className={cn(
                              "font-mono underline-offset-4 hover:underline",
                              routeNote && "italic",
                            )}
                          >
                            {label}
                          </button>
                          {routeNote && (
                            <div className="text-xs text-muted-foreground">
                              {routeNote}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {r.count}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono",
                            r.errors > 0 && "text-destructive",
                          )}
                        >
                          {formatErrorRate(r.errors, r.count)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatDuration(r.p50Ms)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatDuration(r.p95Ms)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatDuration(r.p99Ms)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={7}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No requests in the last {shownWindow} minutes.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {selected ? (
            <RouteCharts stats={selected} windowMinutes={shownWindow} />
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
