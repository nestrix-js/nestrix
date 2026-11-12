import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ChevronRight, RefreshCw } from "lucide-react";
import { parseAsBoolean, parseAsStringLiteral, useQueryStates } from "nuqs";
import { useState } from "react";

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
import { getMeta, getQueries } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SORT,
  isTruncated,
  onlyRepeated,
  preview,
  SORT_KEYS,
  type SortKey,
} from "@/views/queries/queries";

const WINDOWS = [15, 60] as const;
const DEFAULT_WINDOW = 15;

// Window, sort and the N+1 filter are in the URL, so a link or a reload keeps them.
const parsers = {
  windowMinutes: routeWindowParser,
  sort: parseAsStringLiteral(SORT_KEYS),
  nplus: parseAsBoolean,
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
  { label: "Traces", numeric: true },
  { label: "N+1", numeric: true },
  { label: "Example", numeric: false },
];

export function QueriesPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const sort = query.sort ?? DEFAULT_SORT;
  const nplus = query.nplus === true;
  const [paused] = usePaused();
  const [service] = useService();
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

  const rows = onlyRepeated(stats.data?.queries ?? [], nplus);
  const shownWindow = stats.data?.windowMinutes ?? windowMinutes;
  const rowKey = (q: { system: string; statement: string }) =>
    `${q.system}\u0000${q.statement}`;
  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <section className="space-y-4" aria-label="Queries">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Queries</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={nplus ? "default" : "outline"}
            aria-pressed={nplus}
            data-testid="nplus-filter"
            onClick={() => void setQuery({ nplus: nplus ? null : true })}
          >
            N+1 candidates
          </Button>
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

      {stats.isPending && <DataTableSkeleton columnCount={COLUMNS.length} />}
      {stats.isError && stats.data === undefined && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not load queries.</p>
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
          <p
            data-testid="sampled-note"
            className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
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
          <div className="rounded-lg border border-border">
            <Table data-testid="queries">
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
                {rows.length > 0 ? (
                  rows.map((q) => {
                    const key = rowKey(q);
                    const expanded = open.has(key);
                    const long = isTruncated(q.statement);
                    const example = q.exampleTraceIds[0];
                    return (
                      <TableRow key={key} data-testid="query-row">
                        <TableCell className="max-w-[28rem] align-top">
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
                          <Badge variant="outline">{q.system}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono align-top">
                          {q.count}
                        </TableCell>
                        <TableCell className="text-right font-mono align-top">
                          {formatDuration(q.totalMs)}
                        </TableCell>
                        <TableCell className="text-right font-mono align-top">
                          {formatDuration(q.avgMs)}
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
                            q.errors > 0 && "text-destructive",
                          )}
                        >
                          {q.errors}
                        </TableCell>
                        <TableCell className="text-right font-mono align-top">
                          {q.traces}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono align-top",
                            q.repeatedTraces > 0 && "font-semibold",
                          )}
                        >
                          {q.repeatedTraces}
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
                  })
                ) : (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={COLUMNS.length}
                      className="h-24 text-center text-muted-foreground"
                    >
                      {nplus
                        ? `No statement ran 3 or more times in one trace in the last ${shownWindow} minutes.`
                        : `No database or cache queries in the last ${shownWindow} minutes.`}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}
