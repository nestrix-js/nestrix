import type { MethodStats } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, RefreshCw } from "lucide-react";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { Fragment, useMemo, useState } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { BarCell } from "@/components/kit/bar-cell";
import { Chip } from "@/components/kit/chip";
import { Delta } from "@/components/kit/delta";
import { DONUT_RADIUS, Donut, DonutLegend } from "@/components/kit/donut";
import { donutSlices } from "@/components/kit/format";
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
import { getClasses, getMeta } from "@/lib/api";
import { formatDuration, STANDALONE_STATISTICS_NOTE } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser, stringParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import { classChanges, rowAvgChange } from "@/views/classes/class-changes";
import {
  formatShare,
  kindBreakdown,
  summarizeClasses,
} from "@/views/classes/class-kpis";
import {
  DEFAULT_DIR,
  DEFAULT_SORT,
  ENABLE_LINE,
  filterByClass,
  formatOwn,
  methodOwnMs,
  SORT_KEYS,
  type SortKey,
  sortClasses,
  sortMethods,
} from "@/views/classes/class-stats";

const WINDOWS = [
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
] as const;
const DEFAULT_WINDOW = 15;
const STATS = "counted before sampling";
const OWN_SOURCE = "estimated from sampled traces";

// Window and sort are part of the URL, so a link or a reload keeps them.
const parsers = {
  windowMinutes: routeWindowParser,
  sort: parseAsStringLiteral(SORT_KEYS),
  dir: parseAsStringLiteral(["asc", "desc"] as const),
  // From a finding on the route page: the class part of `Class.method`.
  class: stringParser({ maxLength: 256 }),
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

/** Errors as a chip when there are any, a muted zero otherwise. */
const errorCell = (errors: number, of: number) =>
  errors > 0 ? (
    <Chip
      tone="worse"
      className="font-mono"
      title={`${errors} of ${of} calls threw or rejected`}
    >
      {errors}
    </Chip>
  ) : (
    <span className="font-mono text-muted-foreground">0</span>
  );

/** The own-time cell: a bar against the largest own time on screen, "-" without an estimate. */
const ownCell = (ms: number | null, max: number) => (
  <BarCell
    value={ms ?? 0}
    max={max}
    label={formatOwn(ms, formatDuration)}
    color="--chart-1"
  />
);

function MethodRow({ m, maxOwn }: { m: MethodStats; maxOwn: number }) {
  return (
    <TableRow data-testid="method-row" className="bg-muted/40">
      <TableCell className="pl-9 font-mono">{m.method}</TableCell>
      <TableCell />
      <TableCell className="text-right font-mono">{m.calls}</TableCell>
      <TableCell className="text-right">
        {errorCell(m.errors, m.calls)}
      </TableCell>
      <TableCell className="text-right font-mono">
        {formatDuration(m.avgMs)}
      </TableCell>
      <TableCell className="text-right font-mono">
        {formatDuration(m.totalMs)}
      </TableCell>
      <TableCell>{ownCell(methodOwnMs(m), maxOwn)}</TableCell>
      <TableCell />
    </TableRow>
  );
}

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

  const all = stats.data?.classes ?? [];
  const classes = useMemo(
    () => sortClasses(filterByClass(all, query.class), sort, dir),
    [all, sort, dir, query.class],
  );
  const summary = useMemo(() => summarizeClasses(all), [all]);
  const changes = classChanges(stats.data, summary);
  const breakdown = useMemo(() => kindBreakdown(all), [all]);
  const maxOwn = Math.max(
    1,
    ...classes.flatMap((c) => [
      c.ownMs ?? 0,
      ...c.methods.map(methodOwnMs).map((v) => v ?? 0),
    ]),
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

  const ownParts =
    summary.ownMs === null ? null : formatDuration(summary.ownMs).split(" ");
  const on = stats.data?.methodsState === "on";

  return (
    <section className="space-y-6" aria-label="Classes">
      <PageHeader
        title="Classes"
        description="Where the time goes in your controllers, services and providers"
        source={STATS}
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

      {query.class !== null && (
        <div
          data-testid="class-filter"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-muted-foreground">Filtered by class</span>
          <Chip tone="info" className="font-mono">
            {query.class}
          </Chip>
          <Button
            size="sm"
            variant="outline"
            data-testid="clear-class-filter"
            onClick={() => void setQuery({ class: null })}
          >
            Clear
          </Button>
        </div>
      )}
      {stats.isPending && (
        <>
          <SkeletonKpiStrip />
          <SkeletonChart heightClass="h-40" />
          <DataTableSkeleton columnCount={7} />
        </>
      )}
      {stats.isError && stats.data === undefined && (
        <ErrorState
          title="Could not load class statistics."
          message={stats.error?.message}
          onRetry={() => void stats.refetch()}
        />
      )}

      {stats.data?.methodsState === "no-data-in-range" && (
        <EmptyState
          testId="methods-no-data-in-range"
          title="No method spans from this service in the selected range."
        >
          {`The service has sent method spans before, but none in the last ${shownWindow} minutes. Widen the range with the window buttons above.`}
        </EmptyState>
      )}

      {stats.data !== undefined && stats.data.methodsState === "off" && (
        <EmptyState
          testId="methods-disabled"
          title="Method spans are off."
          action={
            <div className="w-full max-w-xl space-y-2 text-left">
              <pre className="overflow-x-auto rounded-md bg-secondary px-3 py-2 text-sm">
                <code className="font-mono">{ENABLE_LINE}</code>
              </pre>
              <p className="text-xs text-muted-foreground">
                They stay off under{" "}
                <code className="font-mono">@nestjs/testing</code>.
              </p>
            </div>
          }
        >
          Class statistics come from method spans. Turn them on by passing the
          instrument when the app is created, in main.ts. The instrument option
          works the same with NestFactory.create,
          NestFactory.createApplicationContext and
          NestFactory.createMicroservice:
        </EmptyState>
      )}

      {on && (
        <>
          {all.length > 0 && (
            <>
              <KpiStrip>
                <StatTile
                  testId="kpi-classes"
                  label="Traced classes"
                  value={String(summary.classes)}
                  unit="with calls"
                  delta={changes.classes.text}
                  deltaTone={changes.classes.tone}
                  deltaTitle={changes.classes.title}
                  source={STATS}
                />
                <StatTile
                  testId="kpi-calls"
                  label="Calls"
                  value={summary.calls.toLocaleString("en")}
                  unit={`in ${shownWindow} min`}
                  delta={changes.calls.text}
                  deltaTone={changes.calls.tone}
                  deltaTitle={changes.calls.title}
                  source={STATS}
                />
                <StatTile
                  testId="kpi-errors"
                  label="Error rate"
                  value={
                    summary.errorRate === null
                      ? "—"
                      : `${(summary.errorRate * 100).toFixed(summary.errorRate >= 0.1 ? 0 : 1)}%`
                  }
                  unit={`${summary.errors.toLocaleString("en")} of ${summary.calls.toLocaleString("en")} calls`}
                  delta={changes.errorRate.text}
                  deltaTone={changes.errorRate.tone}
                  deltaTitle={changes.errorRate.title}
                  source={`threw or rejected · ${STATS}`}
                />
                <StatTile
                  testId="kpi-own"
                  label="Own time"
                  value={ownParts?.[0] ?? "—"}
                  unit={ownParts?.[1]}
                  delta={changes.own.text}
                  deltaTone={changes.own.tone}
                  deltaTitle={changes.own.title}
                  footer={
                    summary.heaviest ? (
                      <span
                        className="truncate font-mono text-xs"
                        title={summary.heaviest.className}
                      >
                        {summary.heaviest.className}
                      </span>
                    ) : undefined
                  }
                  source={ownParts === null ? "no estimate yet" : OWN_SOURCE}
                />
              </KpiStrip>
              {breakdown.shares.length > 0 && (
                <Section
                  testId="card-kind-share"
                  title={
                    breakdown.basis === "own"
                      ? "Own time by kind"
                      : "Total time by kind"
                  }
                  description={
                    breakdown.basis === "own"
                      ? "Duration minus time in child spans, by what the class is"
                      : "Own time has no estimate yet, so this is total call time"
                  }
                  source={breakdown.basis === "own" ? OWN_SOURCE : STATS}
                >
                  <div className="flex flex-wrap items-center gap-6">
                    <Donut
                      testId="donut-kind"
                      label={`${breakdown.basis === "own" ? "Own" : "Total"} time by class kind: ${breakdown.shares
                        .slice()
                        .sort((a, b) => b.value - a.value)
                        .map(
                          (s) =>
                            `${s.label} ${formatShare(s.value, breakdown.sum)}`,
                        )
                        .join(", ")}`}
                      slices={donutSlices(breakdown.shares, DONUT_RADIUS)}
                    >
                      <span className="font-mono text-lg font-semibold">
                        {formatDuration(breakdown.sum)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {breakdown.basis === "own" ? "own time" : "total time"}
                      </span>
                    </Donut>
                    <div className="w-full max-w-sm sm:w-auto sm:min-w-72">
                      <DonutLegend
                        testId="legend-kind"
                        rowTestId="legend-kind-row"
                        items={breakdown.shares.map((s) => ({
                          key: s.key,
                          label: s.label,
                          color: s.color,
                          value: `${formatDuration(s.value)} · ${formatShare(s.value, breakdown.sum)}`,
                        }))}
                      />
                    </div>
                  </div>
                </Section>
              )}
            </>
          )}
          {classes.length > 0 ? (
            <Section
              testId="card-class-table"
              title="Calls and time per class"
              description="Select a class to see its methods"
              source={`${STATS}; own time ${OWN_SOURCE}`}
              flush
            >
              <p
                data-testid="own-note"
                className="border-t border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
              >
                {standalone
                  ? `${STANDALONE_STATISTICS_NOTE} Own time (duration minus time in child spans) is a guide, and a dash means no stored call has it.`
                  : "Calls, errors and durations count every call. Own time (duration minus time in child spans) is estimated from sampled traces, so it is a guide, and a dash means no sampled call is in the store."}
              </p>
              <Table
                data-testid="classes"
                containerClassName="max-h-[70vh]"
                className="min-w-[48rem]"
              >
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
                    <TableHead className="text-right">Avg change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {classes.map((c) => {
                    const expanded = open.has(c.className);
                    return (
                      <Fragment key={c.className}>
                        <TableRow
                          data-testid="class-row"
                          onClick={(e) => {
                            if ((e.target as Element).closest("a, button"))
                              return;
                            toggleOpen(c.className);
                          }}
                          className="cursor-pointer"
                        >
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
                            <Chip>{c.kind}</Chip>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {c.calls}
                          </TableCell>
                          <TableCell className="text-right">
                            {errorCell(c.errors, c.calls)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatDuration(c.avgMs)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatDuration(c.totalMs)}
                          </TableCell>
                          <TableCell>{ownCell(c.ownMs, maxOwn)}</TableCell>
                          <TableCell className="text-right">
                            {(() => {
                              const change = rowAvgChange(c, stats.data);
                              return (
                                <Delta
                                  text={change.text}
                                  tone={change.tone}
                                  title={change.title}
                                />
                              );
                            })()}
                          </TableCell>
                        </TableRow>
                        {expanded &&
                          sortMethods(c.methods, sort, dir).map((m) => (
                            <MethodRow
                              key={`${c.className}.${m.method}`}
                              m={m}
                              maxOwn={maxOwn}
                            />
                          ))}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </Section>
          ) : (
            <EmptyState
              testId="classes"
              title={
                query.class !== null
                  ? `No calls of ${query.class} in the last ${shownWindow} minutes.`
                  : `No method calls in the last ${shownWindow} minutes.`
              }
            >
              Classes appear here once their methods are called.
            </EmptyState>
          )}
        </>
      )}
    </section>
  );
}
