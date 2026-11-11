import { useQuery } from "@tanstack/react-query";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { useTable } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useMemo } from "react";

import { DataTable } from "@/components/data-table/data-table";
import { DataTableFacetedFilter } from "@/components/data-table/data-table-faceted-filter";
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { dataTableFeatures } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import { getRoutes, getTraces, type QueryParams } from "@/lib/api";
import { type RequestFilters, requestFilterParsers } from "@/lib/params";
import { useCursorList } from "@/lib/use-cursor-list";
import { columnLabels, columns } from "@/views/requests/columns";
import { DebouncedInput } from "@/views/requests/debounced-input";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
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
    search: filters.search ?? undefined,
  };
}

const isFiltered = (filters: RequestFilters) =>
  Object.values(filters).some((v) => v !== null);

export function RequestsPage() {
  const [filters, setFilters] = useQueryStates(requestFilterParsers);
  const params = useMemo(() => filtersToParams(filters), [filters]);

  const list = useCursorList({
    name: "traces",
    params,
    fetchPage: getTraces,
  });

  // Route names for the facet; statistics are complete even when the list is sampled.
  const routeStats = useQuery({
    queryKey: ["routes", "facet"],
    queryFn: () => getRoutes(),
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
    >
      <DebouncedInput
        aria-label="Search"
        placeholder="Search name or route"
        className="h-7 w-48"
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
    </DataTableToolbar>
  );

  return (
    <section className="space-y-4" aria-label="Requests">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Requests</h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Reload"
          onClick={list.reload}
        >
          <RefreshCw />
          Reload
        </Button>
      </div>
      {list.status === "loading" && (
        <>
          {toolbar}
          <DataTableSkeleton columnCount={columns.length} />
        </>
      )}
      {list.status === "error" && (
        <>
          {toolbar}
          <div
            role="alert"
            className="space-y-3 rounded-lg border border-border p-6 text-center"
          >
            <p className="font-medium">Could not load requests.</p>
            <p className="text-sm text-muted-foreground">
              {list.error?.message}
            </p>
            <Button variant="outline" onClick={list.reload}>
              Try again
            </Button>
          </div>
        </>
      )}
      {list.status === "ready" && (
        <DataTable
          table={table}
          testId="requests"
          toolbar={toolbar}
          empty={
            filtered
              ? "No requests match these filters."
              : "No requests yet. They appear here as the app handles them."
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
                list.items.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    That is everything the store holds.
                  </p>
                )
              )}
            </div>
          }
        />
      )}
    </section>
  );
}
