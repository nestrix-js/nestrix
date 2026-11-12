import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ChevronRight, RefreshCw } from "lucide-react";
import { parseAsBoolean, parseAsStringLiteral, useQueryStates } from "nuqs";
import { useState } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { BarCell } from "@/components/kit/bar-cell";
import { BarChart } from "@/components/kit/bar-chart";
import { Chip } from "@/components/kit/chip";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/kit/skeletons";
import { KpiStrip, StatTile } from "@/components/kit/stat-tile";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getMeta, getQueries } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser, stringParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import {
  callsPerTrace,
  DEFAULT_SORT,
  filterByText,
  formatPerTrace,
  isTruncated,
  onlyRepeated,
  preview,
  SORT_KEYS,
  type SortKey,
  shortStatement,
  summarizeQueries,
  topBy,
} from "@/views/queries/queries";

const WINDOWS = [
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
] as const;
const DEFAULT_WINDOW = 15;
const SOURCE = "from sampled traces";
// The queries API compares with no previous window, so the tiles show an honest dash.
const NO_PREVIOUS = "The queries API does not compare with a previous window.";

// Window, sort and the N+1 filter are in the URL, so a link or a reload keeps them.
const parsers = {
  windowMinutes: routeWindowParser,
  sort: parseAsStringLiteral(SORT_KEYS),
  nplus: parseAsBoolean,
  // From a finding on the route page: the first characters of one statement.
  q: stringParser({ maxLength: 200 }),
};

const SORTABLE: Record<string, SortKey> = {
  Count: "count",
  Total: "total",
  p95: "p95",
  Max: "max",
};
const COLUMNS: { label: string; numeric: boolean }[] = [
  { label: "Statement", numeric: false },
  { label: "System", numeric: false },
  { label: "Count", numeric: true },
  { label: "Total", numeric: true },
  { label: "Avg", numeric: true },
  { label: "p95", numeric: true },
  { label: "Max", numeric: true },
  { label: "Errors", numeric: true },
  { label: "Per trace", numeric: true },
  { label: "N+1", numeric: false },
  { label: "Example", numeric: false },
];

const rowKey = (q: { system: string; statement: string }) =>
  `${q.system}\u0000${q.statement}`;

export function QueriesPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const sort = query.sort ?? DEFAULT_SORT;
  const nplus = query.nplus === true;
  const [paused] = usePaused();
  const [service] = useService();
  const navigate = useNavigate();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const standalone = meta.data?.mode === "standalone";
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const stats = useQuery({
    queryKey: ["queries", windowMinutes, service, sort],
    queryFn: () => getQueries({ windowMinutes, service, sort }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  const rows = filterByText(
    onlyRepeated(stats.data?.queries ?? [], nplus),
    query.q,
  );
  const shownWindow = stats.data?.windowMinutes ?? windowMinutes;
  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const summary = summarizeQueries(rows);
  const totalParts = formatDuration(summary.totalMs).split(" ");
  const slowestParts = summary.slowest
    ? formatDuration(summary.slowest.avgMs).split(" ")
    : null;
  const slowest = topBy(rows, "avgMs");
  const frequent = topBy(rows, "count");
  const maxTotal = Math.max(0, ...rows.map((q) => q.totalMs));
  const maxAvg = Math.max(0, ...rows.map((q) => q.avgMs));

  return (
    <section className="space-y-6" aria-label="Queries">
      <PageHeader
        title="Queries"
        description="Database and cache statements: where the time goes and what repeats"
        source="traces"
        controls={
          <>
            <Button
              size="sm"
              variant={nplus ? "default" : "outline"}
              aria-pressed={nplus}
              data-testid="nplus-filter"
              onClick={() => void setQuery({ nplus: nplus ? null : true })}
            >
              N+1 candidates
            </Button>
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

      {query.q !== null && (
        <div
          data-testid="statement-filter"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-2 text-sm"
        >
          <span className="text-muted-foreground">Filtered by statement</span>
          <code className="max-w-full truncate rounded bg-secondary px-2 py-0.5 text-xs">
            {query.q}
          </code>
          <Button
            size="sm"
            variant="outline"
            data-testid="clear-statement-filter"
            onClick={() => void setQuery({ q: null })}
          >
            Clear
          </Button>
        </div>
      )}
      {stats.isPending && (
        <>
          <SkeletonKpiStrip />
          <div className="grid gap-4 lg:grid-cols-2">
            <SkeletonChart heightClass="h-40" />
            <SkeletonChart heightClass="h-40" />
          </div>
          <DataTableSkeleton columnCount={COLUMNS.length} />
        </>
      )}
      {stats.isError && stats.data === undefined && (
        <ErrorState
          title="Could not load queries."
          message={stats.error?.message}
          onRetry={() => void stats.refetch()}
        />
      )}

      {stats.data !== undefined && (
        <>
          <p
            data-testid="sampled-note"
            className="-mt-3 text-xs text-muted-foreground"
          >
            {standalone
              ? "Built from the traces stored by the server, which hold only what was sampled."
              : "Built from the sampled traces in the store, not from every query."}{" "}
            Statements are as the instrumentation sanitised them. N+1 counts the
            traces where a statement ran 3 or more times.
          </p>
          {stats.data.truncated && (
            <p
              data-testid="truncated-note"
              className="rounded-lg bg-secondary px-3 py-2 text-sm"
            >
              The store holds more distinct statements than this page tracks, so
              some are missing.
            </p>
          )}
          {rows.length > 0 && (
            <>
              <KpiStrip>
                <StatTile
                  testId="kpi-statements"
                  label="Statements"
                  value={summary.statements.toLocaleString("en")}
                  unit={`in ${shownWindow} min`}
                  delta="—"
                  deltaTitle={NO_PREVIOUS}
                  source={SOURCE}
                />
                <StatTile
                  testId="kpi-total-time"
                  label="Total query time"
                  value={totalParts[0] ?? "—"}
                  unit={totalParts[1]}
                  delta="—"
                  deltaTitle={NO_PREVIOUS}
                  source={`summed over all executions · ${SOURCE}`}
                />
                <StatTile
                  testId="kpi-nplus"
                  label="Likely N+1"
                  value={String(summary.nPlusOne)}
                  unit={summary.nPlusOne === 1 ? "statement" : "statements"}
                  delta="—"
                  deltaTitle={NO_PREVIOUS}
                  source="ran 3 or more times in one trace"
                />
                <StatTile
                  testId="kpi-slowest-mean"
                  label="Slowest mean"
                  value={slowestParts?.[0] ?? "—"}
                  unit={slowestParts?.[1]}
                  footer={
                    summary.slowest && (
                      <span
                        title={summary.slowest.statement}
                        className="truncate font-mono text-xs"
                      >
                        {shortStatement(summary.slowest.statement, 40)}
                      </span>
                    )
                  }
                  source="highest average duration"
                />
              </KpiStrip>
              <div className="grid gap-4 lg:grid-cols-2">
                <Section
                  title="Slowest"
                  description="Statements by average duration"
                  source={SOURCE}
                  testId="card-slowest"
                >
                  <BarChart
                    orientation="horizontal"
                    testId="chart-slowest"
                    label={`Slowest statements by average duration, ${slowest[0] ? `${shortStatement(slowest[0].statement, 40)} at ${formatDuration(slowest[0].avgMs)}` : "none"}`}
                    labelWidthClass="w-48"
                    items={slowest.map((q) => ({
                      key: rowKey(q),
                      label: shortStatement(q.statement),
                      segments: [{ value: q.avgMs, color: "--warning" }],
                      valueLabel: formatDuration(q.avgMs),
                      title: q.statement,
                    }))}
                  />
                </Section>
                <Section
                  title="Most frequent"
                  description="Statements by number of executions"
                  source={SOURCE}
                  testId="card-frequent"
                >
                  <BarChart
                    orientation="horizontal"
                    testId="chart-frequent"
                    label={`Most frequent statements, ${frequent[0] ? `${shortStatement(frequent[0].statement, 40)} ran ${frequent[0].count} times` : "none"}`}
                    labelWidthClass="w-48"
                    items={frequent.map((q) => ({
                      key: rowKey(q),
                      label: shortStatement(q.statement),
                      segments: [{ value: q.count, color: "--chart-1" }],
                      valueLabel: q.count.toLocaleString("en"),
                      title: q.statement,
                    }))}
                  />
                </Section>
              </div>
            </>
          )}
          {rows.length > 0 ? (
            <Section
              title="Statements"
              description="Click a long statement to read it in full; click a row to open its slowest trace"
              source={SOURCE}
              testId="card-statements"
              flush
            >
              <Table data-testid="queries" containerClassName="max-h-[70vh]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {COLUMNS.map((c) => {
                      const key = SORTABLE[c.label];
                      return (
                        <TableHead
                          key={c.label}
                          className={cn(c.numeric && "text-right")}
                          aria-sort={
                            key !== undefined && key === sort
                              ? "descending"
                              : "none"
                          }
                        >
                          {key === undefined ? (
                            c.label
                          ) : (
                            <button
                              type="button"
                              data-testid={`sort-${key}`}
                              onClick={() =>
                                void setQuery({
                                  sort: key === DEFAULT_SORT ? null : key,
                                })
                              }
                              className="inline-flex items-center gap-1 hover:text-foreground"
                            >
                              {c.label}
                              {key === sort && <ArrowDown className="size-3" />}
                            </button>
                          )}
                        </TableHead>
                      );
                    })}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((q) => {
                    const key = rowKey(q);
                    const expanded = open.has(key);
                    const long = isTruncated(q.statement);
                    const example = q.exampleTraceIds[0];
                    return (
                      <TableRow
                        key={key}
                        data-testid="query-row"
                        className={cn(
                          example !== undefined && "cursor-pointer",
                        )}
                        onClick={(event) => {
                          if (example === undefined) return;
                          // A click on the statement or a link belongs to that control.
                          if ((event.target as Element).closest("a, button"))
                            return;
                          void navigate({
                            to: "/traces/$traceId",
                            params: { traceId: example },
                          });
                        }}
                      >
                        <TableCell className="max-w-[28rem] whitespace-normal align-top">
                          {long ? (
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => toggleOpen(key)}
                              data-testid="statement"
                              className="flex w-full items-start gap-1 text-left font-mono text-xs"
                            >
                              <ChevronRight
                                className={cn(
                                  "mt-0.5 size-3 shrink-0 transition-transform",
                                  expanded && "rotate-90",
                                )}
                              />
                              <span
                                className={cn(
                                  "min-w-0",
                                  expanded
                                    ? "whitespace-pre-wrap break-all"
                                    : "break-all",
                                )}
                              >
                                {expanded ? q.statement : preview(q.statement)}
                              </span>
                            </button>
                          ) : (
                            <span
                              data-testid="statement"
                              className="font-mono text-xs break-all"
                            >
                              {preview(q.statement)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          <Chip tone="neutral">{q.system}</Chip>
                        </TableCell>
                        <TableCell className="text-right font-mono align-top tabular-nums">
                          {q.count}
                        </TableCell>
                        <TableCell className="align-top">
                          <BarCell
                            value={q.totalMs}
                            max={maxTotal}
                            label={formatDuration(q.totalMs)}
                            color="--chart-1"
                          />
                        </TableCell>
                        <TableCell className="align-top">
                          <BarCell
                            value={q.avgMs}
                            max={maxAvg}
                            label={formatDuration(q.avgMs)}
                            color="--warning"
                          />
                        </TableCell>
                        <TableCell className="text-right font-mono align-top">
                          {formatDuration(q.p95Ms)}
                        </TableCell>
                        <TableCell className="text-right font-mono align-top">
                          {formatDuration(q.maxMs)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono align-top",
                            q.errors > 0
                              ? "font-semibold text-destructive-text"
                              : "text-muted-foreground",
                          )}
                        >
                          {q.errors}
                        </TableCell>
                        <TableCell
                          title={`${q.count} calls in ${q.traces} traces`}
                          className="text-right font-mono align-top"
                        >
                          {formatPerTrace(callsPerTrace(q))}
                        </TableCell>
                        <TableCell className="align-top">
                          {q.repeatedTraces > 0 ? (
                            <Chip
                              tone="warn"
                              title={`Ran 3 or more times in ${q.repeatedTraces} traces`}
                            >
                              {q.repeatedTraces} traces
                            </Chip>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          {example !== undefined ? (
                            <Link
                              to="/traces/$traceId"
                              params={{ traceId: example }}
                              title={example}
                              data-testid="example-trace"
                              className="font-mono text-xs underline-offset-4 hover:underline"
                            >
                              {example.slice(0, 8)}
                            </Link>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Section>
          ) : (
            <EmptyState
              testId="queries"
              title={
                query.q !== null
                  ? "No statement in this window contains that text."
                  : nplus
                    ? `No statement ran 3 or more times in one trace in the last ${shownWindow} minutes.`
                    : `No database or cache queries in the last ${shownWindow} minutes.`
              }
            >
              {nplus || query.q !== null
                ? "Clear the filter or try the 60 minute window."
                : "Statements appear here once traced requests run database or cache calls."}
            </EmptyState>
          )}
        </>
      )}
    </section>
  );
}
