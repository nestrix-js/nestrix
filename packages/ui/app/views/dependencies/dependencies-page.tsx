import type { DependencyStats, MapNodeKind } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useMemo } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { sparklinePoints } from "@/components/kit/sparkline-points";
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
import { filterByName } from "@/views/dependencies/dependency-filter";

const WINDOWS = [15, 60] as const;
const DEFAULT_WINDOW = 15;
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

const SPARK_W = 96;
const SPARK_H = 24;

/** A small inline chart of one series. SVG attributes and classes only: the CSP forbids style attributes. */
function Sparkline({
  values,
  label,
  className,
}: {
  values: number[];
  label: string;
  className: string;
}) {
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="sparkline"
      data-points={values.length}
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
    >
      <polyline
        points={sparklinePoints(values, SPARK_W, SPARK_H)}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        className={className}
      />
    </svg>
  );
}

const rate = (d: DependencyStats) =>
  d.errors === 0
    ? "0%"
    : `${(d.errorRate * 100).toFixed(d.errorRate < 0.1 ? 1 : 0)}%`;

export function DependenciesPage() {
  const [query, setQuery] = useQueryStates(parsers);
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

  return (
    <section className="space-y-4" aria-label="Dependencies">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Dependencies</h2>
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
            onClick={() => void deps.refetch()}
          >
            <RefreshCw />
            Reload
          </Button>
        </div>
      </div>
      <p
        data-testid="dependencies-note"
        className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
      >
        What the app calls (databases, caches, HTTP services, queues), built
        from sampled traces: calls, error rates and percentiles describe the
        traces in the store, not every call. Trends use {bucketMinutes}-minute
        buckets.
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
      {deps.isPending && <DataTableSkeleton columnCount={7} />}
      {deps.isError && deps.data === undefined && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not load dependencies.</p>
          <p className="text-sm text-muted-foreground">{deps.error?.message}</p>
          <Button variant="outline" onClick={() => void deps.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {deps.data !== undefined &&
        (rows.length === 0 ? (
          <p
            data-testid="dependencies-empty"
            className="rounded-lg border border-border p-6 text-center text-muted-foreground"
          >
            {query.name !== null
              ? `No calls to ${query.name} in the last ${shownWindow} minutes.`
              : `No outbound calls in the last ${shownWindow} minutes.`}
          </p>
        ) : (
          <div className="rounded-lg border border-border">
            <Table data-testid="dependencies">
              <TableHeader>
                <TableRow>
                  <TableHead>Target</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead className="text-right">p50</TableHead>
                  <TableHead className="text-right">p95</TableHead>
                  <TableHead className="text-right">Total time</TableHead>
                  <TableHead>Calls trend</TableHead>
                  <TableHead>p95 trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id} data-testid="dependency-row">
                    <TableCell>
                      <div className="flex flex-col">
                        {d.exampleTraceId !== undefined ? (
                          <Link
                            to="/traces/$traceId"
                            params={{ traceId: d.exampleTraceId }}
                            className="font-medium underline-offset-2 hover:underline"
                            title="Open the trace of the slowest call"
                          >
                            {d.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{d.name}</span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {KIND_LABEL[d.kind] ?? d.kind}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.calls}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        d.errors > 0 && "text-destructive",
                      )}
                    >
                      {d.errors} ({rate(d)})
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(d.p50Ms)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(d.p95Ms)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(d.totalMs)}
                    </TableCell>
                    <TableCell>
                      <Sparkline
                        values={d.series.map((p) => p.calls)}
                        label={`Calls per ${bucketMinutes} min for ${d.name}`}
                        className="stroke-primary"
                      />
                    </TableCell>
                    <TableCell>
                      <Sparkline
                        values={d.series.map((p) => p.p95Ms)}
                        label={`p95 per ${bucketMinutes} min for ${d.name}`}
                        className="stroke-warning"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
    </section>
  );
}
