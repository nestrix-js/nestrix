import type { ErrorItem } from "@nestrix-js/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useQueryState, useQueryStates } from "nuqs";
import type * as React from "react";
import { useMemo, useState } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { BarChart } from "@/components/kit/bar-chart";
import { Chip } from "@/components/kit/chip";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { SkeletonKpiStrip } from "@/components/kit/skeletons";
import { KpiStrip, StatTile } from "@/components/kit/stat-tile";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { RelativeTimeCard } from "@/components/relative-time-card";
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
import { formatRelative } from "@/lib/format";
import {
  errorFilterParsers,
  filterErrorsByType,
  viewParser,
} from "@/lib/params";
import { useService } from "@/lib/service";
import { useCursorList } from "@/lib/use-cursor-list";
import { useNow } from "@/lib/use-now";
import { ErrorGroups } from "@/views/errors/error-groups";
import { NO_TYPE, typeCounts } from "@/views/errors/errors-stats";
import { OTHER_ROUTE, UNMATCHED_ROUTE } from "@/views/routes/route-stats";

const COLUMNS = 5;
const SOURCE = "from sampled traces";

function ErrorRow({ item }: { item: ErrorItem }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const detailId = `error-detail-${item.cursor}`;
  return (
    <>
      <TableRow
        data-testid="error-row"
        className="cursor-pointer"
        onClick={(event) => {
          // A click on the message button or the link belongs to that control.
          if ((event.target as Element).closest("a, button")) return;
          void navigate({
            to: "/traces/$traceId",
            params: { traceId: item.traceId },
          });
        }}
      >
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
            <span className="font-mono text-xs">{item.route}</span>
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
                <Chip tone="neutral" className="font-mono">
                  {item.method}
                </Chip>
              )}
              {item.statusCode !== undefined && (
                <Chip
                  tone={item.statusCode >= 500 ? "worse" : "warn"}
                  className="font-mono"
                >
                  {item.statusCode}
                </Chip>
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

function AllErrors({ viewToggle }: { viewToggle: React.ReactNode }) {
  const [filters, setFilters] = useQueryStates(errorFilterParsers);
  const [service] = useService();
  const now = useNow();
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
  const types = useMemo(() => typeCounts(shown), [shown]);
  const routeQuery = filters.route
    ? `&route=${encodeURIComponent(filters.route)}`
    : "";

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-2">
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
        <Button variant="ghost" size="sm" onClick={() => void setFilters(null)}>
          Reset
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6" data-testid="errors-all">
      <PageHeader
        title="Errors"
        description="Every error event in the store, newest first"
        source="traces"
        controls={
          <>
            {viewToggle}
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
      {toolbar}

      {list.status === "loading" && (
        <>
          <SkeletonKpiStrip count={3} />
          <DataTableSkeleton columnCount={COLUMNS} />
        </>
      )}
      {list.status === "error" && (
        <ErrorState
          title="Could not load errors."
          message={list.error?.message}
          onRetry={list.reload}
        />
      )}
      {list.status === "ready" && shown.length > 0 && (
        <>
          <KpiStrip columns={3}>
            <StatTile
              testId="kpi-loaded"
              label="Events loaded"
              value={shown.length.toLocaleString("en")}
              unit={
                list.hasOlder ? "so far, older ones available" : "all stored"
              }
              source={SOURCE}
            />
            <StatTile
              testId="kpi-types"
              label="Exception types"
              value={String(types.length)}
              unit="distinct"
              source="in the loaded events"
            />
            <StatTile
              testId="kpi-latest"
              label="Latest error"
              value={shown[0] ? formatRelative(shown[0].timeUnixMs, now) : "—"}
              footer={
                <span className="truncate font-mono text-xs">
                  {shown[0]?.errorType ?? "-"}
                </span>
              }
              source={`most frequent type: ${types[0]?.label ?? "—"}`}
            />
          </KpiStrip>
          {types.length > 1 && (
            <Section
              title="Types in these events"
              description="Click a type to filter the list"
              source={`${shown.length.toLocaleString("en")} loaded events · ${SOURCE}`}
              testId="card-error-types"
            >
              <BarChart
                orientation="horizontal"
                testId="types-chart"
                label={`Loaded events by exception type, most are ${types[0]?.label ?? "none"}`}
                labelWidthClass="w-56"
                items={types.slice(0, 6).map((t) => ({
                  key: t.label,
                  label: t.label,
                  segments: [{ value: t.count, color: "--destructive" }],
                  valueLabel: String(t.count),
                  title: `${t.label}: ${t.count} events`,
                  ...(t.label === NO_TYPE
                    ? {}
                    : {
                        to: `/errors?view=all&type=${encodeURIComponent(t.type ?? t.label)}${routeQuery}`,
                      }),
                }))}
              />
            </Section>
          )}
        </>
      )}
      {list.status === "ready" && (
        <div className="space-y-3">
          {shown.length > 0 ? (
            <Section
              title="Error events"
              description="Newest first; click a row to open its trace"
              source={SOURCE}
              testId="card-error-events"
              flush
            >
              <Table data-testid="errors" containerClassName="max-h-[70vh]">
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
                  {shown.map((item) => (
                    <ErrorRow key={item.cursor} item={item} />
                  ))}
                </TableBody>
              </Table>
            </Section>
          ) : filters.type !== null ? (
            <EmptyState title="No loaded errors of this type.">
              Load older events or clear the type filter.
            </EmptyState>
          ) : filtered ? (
            <EmptyState title="No errors for this route.">
              Pick another route or reset the filter.
            </EmptyState>
          ) : (
            <EmptyState title="No errors yet.">
              Failed requests and spans appear here. Send a failing request to
              your app and it shows up within a few seconds.
            </EmptyState>
          )}
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
  { value: "grouped", label: "Grouped" },
  { value: "all", label: "Every event" },
] as const;

export function ErrorsPage() {
  const [view, setView] = useQueryState("view", viewParser);
  const viewToggle = (
    <SegmentedControl
      label="Error view"
      options={VIEWS}
      value={view}
      onChange={(v) => void setView(v)}
    />
  );
  return (
    <section className="space-y-6" aria-label="Errors">
      {view === "grouped" ? (
        <ErrorGroups viewToggle={viewToggle} />
      ) : (
        <AllErrors viewToggle={viewToggle} />
      )}
    </section>
  );
}
