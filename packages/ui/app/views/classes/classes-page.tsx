import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, RefreshCw } from "lucide-react";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { Fragment, useMemo, useState } from "react";

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
import { getClasses, getMeta } from "@/lib/api";
import { formatDuration, STANDALONE_STATISTICS_NOTE } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import {
  DEFAULT_DIR,
  DEFAULT_SORT,
  ENABLE_LINE,
  formatOwn,
  methodOwnMs,
  SORT_KEYS,
  type SortKey,
  sortClasses,
  sortMethods,
} from "@/views/classes/class-stats";

const WINDOWS = [15, 60] as const;
const DEFAULT_WINDOW = 15;

// Window and sort are part of the URL, so a link or a reload keeps them.
const parsers = {
  windowMinutes: routeWindowParser,
  sort: parseAsStringLiteral(SORT_KEYS),
  dir: parseAsStringLiteral(["asc", "desc"] as const),
};

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "name", label: "Class", numeric: false },
  { key: "kind", label: "Kind", numeric: false },
  { key: "calls", label: "Calls", numeric: true },
  { key: "errors", label: "Errors", numeric: true },
  { key: "avg", label: "Avg", numeric: true },
  { key: "total", label: "Total", numeric: true },
  { key: "own", label: "Own", numeric: true },
];

export function ClassesPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const sort = query.sort ?? DEFAULT_SORT;
  const dir = query.dir ?? DEFAULT_DIR;
  const [paused] = usePaused();
  const [service] = useService();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const standalone = meta.data?.mode === "standalone";
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const stats = useQuery({
    queryKey: ["classes", windowMinutes, service],
    queryFn: () => getClasses({ windowMinutes, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  const classes = useMemo(
    () => sortClasses(stats.data?.classes ?? [], sort, dir),
    [stats.data, sort, dir],
  );
  const shownWindow = stats.data?.windowMinutes ?? windowMinutes;

  const toggleSort = (key: SortKey) => {
    const next =
      key === sort
        ? dir === "desc"
          ? "asc"
          : "desc"
        : key === "name" || key === "kind"
          ? "asc"
          : "desc";
    void setQuery({
      sort: key === DEFAULT_SORT ? null : key,
      dir: next === DEFAULT_DIR ? null : next,
    });
  };
  const toggleOpen = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <section className="space-y-4" aria-label="Classes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Classes</h2>
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

      {stats.isPending && <DataTableSkeleton columnCount={8} />}
      {stats.isError && stats.data === undefined && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not load class statistics.</p>
          <p className="text-sm text-muted-foreground">
            {stats.error?.message}
          </p>
          <Button variant="outline" onClick={() => void stats.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {stats.data !== undefined && !stats.data.methodsEnabled && (
        <div
          data-testid="methods-disabled"
          className="space-y-2 rounded-lg border border-border p-6"
        >
          <p className="font-medium">Method spans are off.</p>
          <p className="text-sm text-muted-foreground">
            Class statistics come from method spans. Turn them on by passing the
            instrument when the app is created, in{" "}
            <code className="font-mono">main.ts</code>:
          </p>
          <pre className="overflow-x-auto rounded-md bg-secondary px-3 py-2 text-sm">
            <code className="font-mono">{ENABLE_LINE}</code>
          </pre>
          <p className="text-xs text-muted-foreground">
            They stay off under{" "}
            <code className="font-mono">@nestjs/testing</code>.
          </p>
        </div>
      )}

      {stats.data?.methodsEnabled && (
        <>
          <p
            data-testid="own-note"
            className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
          >
            {standalone
              ? `${STANDALONE_STATISTICS_NOTE} Own time (duration minus time in child spans) is a guide, and a dash means no stored call has it.`
              : "Calls, errors and durations count every call. Own time (duration minus time in child spans) is estimated from sampled traces, so it is a guide, and a dash means no sampled call is in the store."}
          </p>
          <div className="rounded-lg border border-border">
            <Table data-testid="classes">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {COLUMNS.map((c) => {
                    const active = sort === c.key;
                    return (
                      <TableHead
                        key={c.key}
                        className={cn(c.numeric && "text-right")}
                        aria-sort={
                          active
                            ? dir === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          data-testid={`sort-${c.key}`}
                          onClick={() => toggleSort(c.key)}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          {c.label}
                          {active &&
                            (dir === "asc" ? (
                              <ArrowUp className="size-3" />
                            ) : (
                              <ArrowDown className="size-3" />
                            ))}
                        </button>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {classes.length > 0 ? (
                  classes.map((c) => {
                    const expanded = open.has(c.className);
                    return (
                      <Fragment key={c.className}>
                        <TableRow data-testid="class-row">
                          <TableCell>
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => toggleOpen(c.className)}
                              className="inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline"
                            >
                              <ChevronRight
                                className={cn(
                                  "size-4 transition-transform",
                                  expanded && "rotate-90",
                                )}
                              />
                              {c.className}
                            </button>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{c.kind}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {c.calls}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-mono",
                              c.errors > 0 && "text-destructive",
                            )}
                          >
                            {c.errors}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatDuration(c.avgMs)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatDuration(c.totalMs)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatOwn(c.ownMs, formatDuration)}
                          </TableCell>
                        </TableRow>
                        {expanded &&
                          sortMethods(c.methods, sort, dir).map((m) => (
                            <TableRow
                              key={`${c.className}.${m.method}`}
                              data-testid="method-row"
                              className="bg-muted/40"
                            >
                              <TableCell className="pl-9 font-mono">
                                {m.method}
                              </TableCell>
                              <TableCell />
                              <TableCell className="text-right font-mono">
                                {m.calls}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "text-right font-mono",
                                  m.errors > 0 && "text-destructive",
                                )}
                              >
                                {m.errors}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatDuration(m.avgMs)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatDuration(m.totalMs)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatOwn(methodOwnMs(m), formatDuration)}
                              </TableCell>
                            </TableRow>
                          ))}
                      </Fragment>
                    );
                  })
                ) : (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={COLUMNS.length}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No method calls in the last {shownWindow} minutes.
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
