import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { useTable } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useMemo, useState } from "react";

import { DataTable } from "@/components/data-table/data-table";
import { DataTableFacetedFilter } from "@/components/data-table/data-table-faceted-filter";
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { dataTableFeatures } from "@/components/data-table/features";
import { PageHeader } from "@/components/kit/page-header";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/kit/skeletons";
import { KpiStrip, StatTile } from "@/components/kit/stat-tile";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { Button } from "@/components/ui/button";
import { getRoutes, getTimeline, getTraces, type QueryParams } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { type RequestFilters, requestFilterParsers } from "@/lib/params";
import { useService } from "@/lib/service";
import { useCursorList } from "@/lib/use-cursor-list";
import { columnLabels, columnsFor } from "@/views/requests/columns";
import { DebouncedInput } from "@/views/requests/debounced-input";
import { RequestTimeline } from "@/views/requests/request-timeline";
import {
  formatErrorShare,
  percentile,
  slowestInWindow,
  timelineTotals,
} from "@/views/requests/requests-stats";
import { SavedFiltersMenu } from "@/views/requests/saved-filters-menu";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const TYPES = [
  { label: "All", value: "" },
  { label: "HTTP", value: "http" },
  { label: "Jobs", value: "job", title: "Traces with job processing" },
  { label: "Scheduled", value: "scheduled" },
];
const WINDOWS = [
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
] as const;
// The request list has no previous window to compare with, so the tiles show an honest dash.
const NO_PREVIOUS = "The request list does not compare with a previous window.";
const SOURCE_TRACES = "from sampled traces";
const STATUSES = [
  { label: "ok", value: "ok" },
  { label: "error", value: "error" },
  { label: "4xx", value: "4xx" },
  { label: "5xx", value: "5xx" },
];

/** URL filters as query parameters; unset ones are left out. */
export function filtersToParams(filters: RequestFilters): QueryParams {
  return {
    route: filters.route ?? undefined,
    method: filters.method ?? undefined,
    status: filters.status ?? undefined,
    minDurationMs: filters.minDurationMs ?? undefined,
    maxDurationMs: filters.maxDurationMs ?? undefined,
    search: filters.search ?? undefined,
    type: filters.type ?? undefined,
    release: filters.release ?? undefined,
    user: filters.user ?? undefined,
    fromUnixMs: filters.fromUnixMs ?? undefined,
    toUnixMs: filters.toUnixMs ?? undefined,
  };
}

const isFiltered = (filters: RequestFilters) =>
  Object.values(filters).some((v) => v !== null);

export function RequestsPage() {
  const [filters, setFilters] = useQueryStates(requestFilterParsers);
  const [service] = useService();
  const params = useMemo(
    () => ({ ...filtersToParams(filters), service }),
    [filters, service],
  );

  // The timeline shows the whole window; it takes the list's filters except the time range and the minimum duration.
  const timelineParams = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(params).filter(
          ([key]) =>
            key !== "minDurationMs" &&
            key !== "fromUnixMs" &&
            key !== "toUnixMs",
        ),
      ),
    [params],
  );

  const list = useCursorList({
    name: "traces",
    params,
    fetchPage: getTraces,
  });

  // The window is shared by the tiles and the timeline, so it lives here.
  const [windowMinutes, setWindowMinutes] = useState<number>(WINDOWS[0].value);
  const [paused] = usePaused();
  const timeline = useQuery({
    queryKey: ["timeline", windowMinutes, timelineParams],
    queryFn: () => getTimeline({ windowMinutes, ...timelineParams }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const navigate = useNavigate();

  // Route names for the facet; statistics are complete even when the list is sampled.
  const routeStats = useQuery({
    queryKey: ["routes", "facet", service],
    queryFn: () => getRoutes({ service }),
    staleTime: 30_000,
  });
  const routeOptions = useMemo(
    () =>
      [...new Set((routeStats.data?.routes ?? []).map((r) => r.route))].map(
        (route) => ({ label: route, value: route }),
      ),
    [routeStats.data],
  );

  const columnFilters = useMemo<ColumnFiltersState>(
    () =>
      (["route", "method", "status"] as const).flatMap((id) =>
        filters[id] === null ? [] : [{ id, value: filters[id] }],
      ),
    [filters],
  );

  const hasRelease = list.items.some((i) => i.release);
  const hasUser = list.items.some((i) => i.user);
  // Duration bars are relative to the slowest row on screen.
  const maxDurationMs = useMemo(
    () => list.items.reduce((max, i) => Math.max(max, i.durationMs), 0),
    [list.items],
  );
  const columns = useMemo(
    () => columnsFor(hasRelease, hasUser, maxDurationMs),
    [hasRelease, hasUser, maxDurationMs],
  );

  const table = useTable({
    features: dataTableFeatures,
    columns,
    data: list.items,
    getRowId: (row) => row.cursor,
    // The server filters and orders (newest first); the table only holds the state.
    manualFiltering: true,
    manualSorting: true,
    enableSorting: false,
    state: { columnFilters },
    onColumnFiltersChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(columnFilters) : updater;
      const value = (id: string) => {
        const found = next.find((f) => f.id === id)?.value;
        return typeof found === "string" ? found : null;
      };
      const status = value("status");
      void setFilters({
        route: value("route"),
        method: value("method"),
        status: STATUSES.some((s) => s.value === status)
          ? (status as RequestFilters["status"])
          : null,
      });
    },
  });

  const filtered = isFiltered(filters);
  const toolbar = (
    <DataTableToolbar
      table={table}
      labels={columnLabels}
      isFiltered={filtered}
      onReset={() => void setFilters(null)}
      className="rounded-lg border border-border bg-muted/30 p-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DebouncedInput
          aria-label="Search"
          placeholder="Search name or route"
          className="h-7 w-full min-w-40 sm:w-64"
          value={filters.search ?? ""}
          onCommit={(v) => void setFilters({ search: v === "" ? null : v })}
        />
        <DataTableFacetedFilter
          column={table.getColumn("route")}
          title="Route"
          options={routeOptions}
        />
        <DataTableFacetedFilter
          column={table.getColumn("method")}
          title="Method"
          options={METHODS.map((m) => ({ label: m, value: m }))}
        />
        <DataTableFacetedFilter
          column={table.getColumn("status")}
          title="Status"
          options={STATUSES}
        />
        <select
          aria-label="Type"
          data-testid="type-filter"
          className="h-7 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={filters.type ?? ""}
          onChange={(e) => {
            const type = TYPES.find((t) => t.value === e.target.value)?.value;
            void setFilters({
              type: type ? (type as RequestFilters["type"]) : null,
            });
          }}
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value} title={t.title}>
              {t.value === "" ? "Type: All" : t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DebouncedInput
          aria-label="Release"
          placeholder="Release"
          className="h-7 w-28"
          value={filters.release ?? ""}
          onCommit={(v) => void setFilters({ release: v === "" ? null : v })}
        />
        <DebouncedInput
          aria-label="User"
          placeholder="User"
          className="h-7 w-28"
          value={filters.user ?? ""}
          onCommit={(v) => void setFilters({ user: v === "" ? null : v })}
        />
        <DebouncedInput
          aria-label="Minimum duration (ms)"
          placeholder="Min ms"
          type="number"
          min={0}
          className="h-7 w-24"
          value={
            filters.minDurationMs === null ? "" : String(filters.minDurationMs)
          }
          onCommit={(v) => {
            const n = v.trim() === "" ? Number.NaN : Number(v);
            void setFilters({
              minDurationMs: Number.isFinite(n) && n >= 0 ? n : null,
            });
          }}
        />
        <span aria-hidden className="text-muted-foreground">
          to
        </span>
        <DebouncedInput
          aria-label="Maximum duration (ms)"
          placeholder="Max ms"
          type="number"
          min={0}
          className="h-7 w-24"
          value={
            filters.maxDurationMs === null ? "" : String(filters.maxDurationMs)
          }
          onCommit={(v) => {
            const n = v.trim() === "" ? Number.NaN : Number(v);
            void setFilters({
              maxDurationMs: Number.isFinite(n) && n >= 0 ? n : null,
            });
          }}
        />
      </div>
      <SavedFiltersMenu filters={filters} onApply={(f) => void setFilters(f)} />
    </DataTableToolbar>
  );

  const totals = timelineTotals(timeline.data);
  const windowEnd = timeline.data
    ? timeline.data.fromUnixMs +
      timeline.data.buckets.length * timeline.data.bucketMs
    : 0;
  const slowest = timeline.data
    ? slowestInWindow(list.items, timeline.data.fromUnixMs, windowEnd)
    : null;
  const p95 = percentile(
    list.items.map((i) => i.durationMs),
    0.95,
  );
  const p95Parts = p95 === null ? null : formatDuration(p95).split(" ");
  const slowestParts = slowest
    ? formatDuration(slowest.durationMs).split(" ")
    : null;
  const kpisReady = timeline.data !== undefined;

  return (
    <section className="space-y-6" aria-label="Requests">
      <PageHeader
        title="Requests"
        description="Every request the app handled, newest first"
        source="traces"
        controls={
          <>
            <SegmentedControl
              label="Timeline window"
              options={WINDOWS}
              value={windowMinutes}
              onChange={setWindowMinutes}
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label="Reload"
              onClick={list.reload}
            >
              <RefreshCw />
              Reload
            </Button>
          </>
        }
      />
      {kpisReady && (
        <KpiStrip>
          <StatTile
            testId="kpi-requests"
            label="Requests"
            value={totals.total.toLocaleString("en")}
            unit={`in ${windowMinutes} min`}
            delta="—"
            deltaTitle={NO_PREVIOUS}
            series={totals.perBucket}
            seriesColor="--chart-1"
            source={SOURCE_TRACES}
          />
          <StatTile
            testId="kpi-error-rate"
            label="Error rate"
            value={formatErrorShare(totals)}
            unit={
              totals.total > 0
                ? `${totals.serverErrors.toLocaleString("en")} of ${totals.total.toLocaleString("en")}`
                : undefined
            }
            delta="—"
            deltaTitle={NO_PREVIOUS}
            series={totals.serverPerBucket}
            seriesColor="--destructive"
            source={`5xx or thrown · ${SOURCE_TRACES}`}
          />
          <StatTile
            testId="kpi-p95"
            label="p95 duration"
            value={p95Parts?.[0] ?? "—"}
            unit={p95Parts?.[1]}
            delta="—"
            deltaTitle={NO_PREVIOUS}
            source={`of the ${list.items.length} requests listed`}
          />
          <StatTile
            testId="kpi-slowest"
            label="Slowest request"
            value={slowestParts?.[0] ?? "—"}
            unit={slowestParts?.[1]}
            footer={
              slowest ? (
                <Link
                  to="/traces/$traceId"
                  params={{ traceId: slowest.traceId }}
                  data-testid="kpi-slowest-link"
                  className="truncate font-mono text-xs underline-offset-4 hover:underline"
                >
                  {slowest.route ?? slowest.name}
                </Link>
              ) : undefined
            }
            source="in the window, among those listed"
          />
        </KpiStrip>
      )}
      {!kpisReady && !timeline.isError && (
        <>
          <SkeletonKpiStrip />
          <SkeletonChart heightClass="h-36" />
        </>
      )}
      {(kpisReady || timeline.isError) && (
        <RequestTimeline
          data={timeline.data}
          error={timeline.isError ? timeline.error : null}
          range={
            filters.fromUnixMs !== null && filters.toUnixMs !== null
              ? { fromUnixMs: filters.fromUnixMs, toUnixMs: filters.toUnixMs }
              : null
          }
          onRange={(r) =>
            void setFilters({
              fromUnixMs: r?.fromUnixMs ?? null,
              toUnixMs: r?.toUnixMs ?? null,
            })
          }
        />
      )}
      {list.status === "loading" && (
        <>
          {toolbar}
          <DataTableSkeleton columnCount={7} />
        </>
      )}
      {list.status === "error" && (
        <>
          {toolbar}
          <ErrorState
            title="Could not load requests."
            message={list.error?.message}
            onRetry={list.reload}
          />
        </>
      )}
      {list.status === "ready" && list.items.length === 0 && (
        <>
          {toolbar}
          {filtered ? (
            <EmptyState title="No requests match these filters.">
              Widen the time range or reset the filters.
            </EmptyState>
          ) : (
            <EmptyState title="No requests yet.">
              They appear here as the app handles them. Send a request to your
              app and it shows up within a few seconds.
            </EmptyState>
          )}
        </>
      )}
      {list.status === "ready" && list.items.length > 0 && (
        <DataTable
          table={table}
          testId="requests"
          toolbar={toolbar}
          containerClassName="max-h-[70vh]"
          onRowClick={(row) =>
            void navigate({
              to: "/traces/$traceId",
              params: { traceId: row.traceId },
            })
          }
          footer={
            <div className="flex flex-col items-center gap-2">
              {list.olderError && (
                <p role="alert" className="text-sm text-destructive">
                  Could not load older requests: {list.olderError.message}
                </p>
              )}
              {list.hasOlder ? (
                <Button
                  variant="outline"
                  disabled={list.loadingOlder}
                  onClick={() => void list.loadOlder()}
                >
                  {list.loadingOlder ? "Loading" : "Load older"}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  That is everything the store holds.
                </p>
              )}
            </div>
          }
        />
      )}
    </section>
  );
}
