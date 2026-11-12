import type { ErrorItem } from "@nestrix-js/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useQueryState, useQueryStates } from "nuqs";
import { useMemo, useState } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { RelativeTimeCard } from "@/components/relative-time-card";
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
import { getErrors, getRoutes } from "@/lib/api";
import {
  errorFilterParsers,
  filterErrorsByType,
  viewParser,
} from "@/lib/params";
import { useService } from "@/lib/service";
import { useCursorList } from "@/lib/use-cursor-list";
import { ErrorGroups } from "@/views/errors/error-groups";
import { OTHER_ROUTE, UNMATCHED_ROUTE } from "@/views/routes/route-stats";

const COLUMNS = 5;

function ErrorRow({ item }: { item: ErrorItem }) {
  const [open, setOpen] = useState(false);
  const detailId = `error-detail-${item.cursor}`;
  return (
    <>
      <TableRow data-testid="error-row">
        <TableCell>
          <RelativeTimeCard timeUnixMs={item.timeUnixMs} />
        </TableCell>
        <TableCell>
          <div className="font-mono">{item.errorType ?? "-"}</div>
          <div className="font-mono text-xs text-muted-foreground">
            {item.spanName}
          </div>
        </TableCell>
        <TableCell className="max-w-md">
          {item.message ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              title={open ? "Hide the full message" : "Show the full message"}
              onClick={() => setOpen(!open)}
              className="flex w-full items-center gap-1 text-left"
            >
              {open ? (
                <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
              )}
              <span className="truncate" data-testid="error-message">
                {item.message}
              </span>
            </button>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
        <TableCell>
          {item.route ? (
            <span className="font-mono">{item.route}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
        <TableCell>
          <Link
            to="/traces/$traceId"
            params={{ traceId: item.traceId }}
            title={item.traceId}
            className="underline-offset-4 hover:underline"
          >
            View trace
          </Link>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent" data-testid="error-detail">
          <TableCell id={detailId} colSpan={COLUMNS} className="bg-muted/30">
            <pre className="font-mono text-xs break-words whitespace-pre-wrap">
              {item.message}
            </pre>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {item.method && (
                <Badge variant="outline" className="font-mono">
                  {item.method}
                </Badge>
              )}
              {item.statusCode !== undefined && (
                <Badge
                  variant={item.statusCode >= 500 ? "destructive" : "secondary"}
                  className="font-mono"
                >
                  {item.statusCode}
                </Badge>
              )}
              <span>{item.spanKind} span</span>
              <span className="font-mono">{item.spanId}</span>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function AllErrors() {
  const [filters, setFilters] = useQueryStates(errorFilterParsers);
  const [service] = useService();
  const params = useMemo(
    () => ({ route: filters.route ?? undefined, service }),
    [filters.route, service],
  );
  const list = useCursorList({ name: "errors", params, fetchPage: getErrors });

  // Route names for the filter; the same query the request list's facet uses.
  const routeStats = useQuery({
    queryKey: ["routes", "facet", service],
    queryFn: () => getRoutes({ service }),
    staleTime: 30_000,
  });
  const routeOptions = useMemo(() => {
    const names = new Set(
      (routeStats.data?.routes ?? [])
        .map((r) => r.route)
        .filter((r) => r !== UNMATCHED_ROUTE && r !== OTHER_ROUTE),
    );
    // A route from the URL stays selectable even when the statistics no longer list it.
    if (filters.route) names.add(filters.route);
    return [...names].sort();
  }, [routeStats.data, filters.route]);

  const filtered = filters.route !== null || filters.type !== null;
  const shown = useMemo(
    () => filterErrorsByType(list.items, filters.type),
    [list.items, filters.type],
  );
  return (
    <div className="space-y-4" data-testid="errors-all">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Route</span>
          <select
            className="h-7 rounded-lg border border-border bg-background px-2 text-sm"
            value={filters.route ?? ""}
            onChange={(e) => void setFilters({ route: e.target.value || null })}
          >
            <option value="">All routes</option>
            {routeOptions.map((route) => (
              <option key={route} value={route}>
                {route}
              </option>
            ))}
          </select>
        </label>
        {filters.type !== null && (
          <span
            data-testid="type-filter"
            className="flex items-center gap-2 text-sm"
          >
            <span className="text-muted-foreground">Type</span>
            <code className="rounded bg-secondary px-2 py-0.5 text-xs">
              {filters.type}
            </code>
            <Button
              size="sm"
              variant="outline"
              data-testid="clear-type-filter"
              onClick={() => void setFilters({ type: null })}
            >
              Clear
            </Button>
          </span>
        )}
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void setFilters(null)}
          >
            Reset
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Reload"
          className="ml-auto"
          onClick={list.reload}
        >
          <RefreshCw />
          Reload
        </Button>
      </div>

      {list.status === "loading" && <DataTableSkeleton columnCount={COLUMNS} />}
      {list.status === "error" && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not load errors.</p>
          <p className="text-sm text-muted-foreground">{list.error?.message}</p>
          <Button variant="outline" onClick={list.reload}>
            Try again
          </Button>
        </div>
      )}
      {list.status === "ready" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border">
            <Table data-testid="errors">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Trace</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length > 0 ? (
                  shown.map((item) => (
                    <ErrorRow key={item.cursor} item={item} />
                  ))
                ) : (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={COLUMNS}
                      className="h-24 text-center text-muted-foreground"
                    >
                      {filters.type !== null
                        ? "No loaded errors of this type."
                        : filtered
                          ? "No errors for this route."
                          : "No errors yet. Failed requests and spans appear here."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-col items-center gap-2">
            {list.olderError && (
              <p role="alert" className="text-sm text-destructive">
                Could not load older errors: {list.olderError.message}
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
        </div>
      )}
    </div>
  );
}

const VIEWS = [
  ["grouped", "Grouped"],
  ["all", "All"],
] as const;

export function ErrorsPage() {
  const [view, setView] = useQueryState("view", viewParser);
  return (
    <section className="space-y-4" aria-label="Errors">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Errors</h2>
        <fieldset className="flex items-center gap-1" aria-label="Error view">
          {VIEWS.map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={view === value ? "default" : "outline"}
              aria-pressed={view === value}
              onClick={() => void setView(value)}
            >
              {label}
            </Button>
          ))}
        </fieldset>
      </div>
      {view === "grouped" ? <ErrorGroups /> : <AllErrors />}
    </section>
  );
}
