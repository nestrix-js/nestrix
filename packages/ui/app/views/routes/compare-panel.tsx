import type { RouteCompareRow } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";

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
import { getRouteCompare } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { cn } from "@/lib/utils";
import {
  type CompareSortKey,
  formatDeltaCount,
  formatDeltaMs,
  formatDeltaRate,
  REGRESSION,
  sortCompareRows,
  verdictOf,
} from "@/views/routes/route-insights";
import {
  describeMethod,
  describeRoute,
  formatErrorRate,
  routeKey,
} from "@/views/routes/route-stats";

export type CompareMode = "window" | "release";

interface Props {
  mode: CompareMode;
  onMode: (mode: CompareMode) => void;
  windowMinutes: number;
  releaseA: string | null;
  releaseB: string | null;
  onReleases: (a: string | null, b: string | null) => void;
  service: string | undefined;
}

const COLUMNS: { key: CompareSortKey; label: string; right: boolean }[] = [
  { key: "route", label: "Route", right: false },
  { key: "count", label: "Requests", right: true },
  { key: "errorRate", label: "Error rate", right: true },
  { key: "p50Ms", label: "p50", right: true },
  { key: "p95Ms", label: "p95", right: true },
];

const MUTED = "text-muted-foreground";
/** A larger delta is worse for latency and error rate: only a rise is coloured. */
const toneOf = (n: number | null) =>
  n !== null && n > 0 ? "text-destructive" : MUTED;

function Delta({
  before,
  after,
  delta,
  tone,
}: {
  before: string;
  after: string;
  delta: string;
  tone: string;
}) {
  return (
    <TableCell className="text-right font-mono">
      <div>
        {before} <span className={MUTED}>to</span> {after}
      </div>
      <div className={cn("text-xs", tone)}>{delta}</div>
    </TableCell>
  );
}

function CompareRowView({ row: r }: { row: RouteCompareRow }) {
  const { label } = describeRoute(r);
  const verdict = verdictOf(r);
  const ms = (count: number, v: number) =>
    count > 0 ? formatDuration(v) : "-";
  return (
    <TableRow
      data-testid="compare-row"
      data-verdict={verdict}
      className={cn(verdict === "regression" && "bg-destructive/10")}
    >
      <TableCell>
        <Badge variant="outline" className="mr-2 font-mono">
          {describeMethod(r.method)}
        </Badge>
        <span className="font-mono" title={routeKey(r)}>
          {label}
        </span>
        {verdict === "regression" && (
          <Badge variant="destructive" className="ml-2">
            regression
          </Badge>
        )}
        {verdict === "improvement" && (
          <Badge variant="secondary" className="ml-2">
            faster
          </Badge>
        )}
      </TableCell>
      <Delta
        before={String(r.before.count)}
        after={String(r.after.count)}
        delta={formatDeltaCount(r.delta.count)}
        tone={MUTED}
      />
      <Delta
        before={formatErrorRate(r.before.errors, r.before.count)}
        after={formatErrorRate(r.after.errors, r.after.count)}
        delta={formatDeltaRate(r.delta.errorRate)}
        tone={toneOf(r.delta.errorRate)}
      />
      <Delta
        before={ms(r.before.count, r.before.p50Ms)}
        after={ms(r.after.count, r.after.p50Ms)}
        delta={formatDeltaMs(r.delta.p50Ms)}
        tone={toneOf(r.delta.p50Ms)}
      />
      <Delta
        before={ms(r.before.count, r.before.p95Ms)}
        after={ms(r.after.count, r.after.p95Ms)}
        delta={formatDeltaMs(r.delta.p95Ms)}
        tone={toneOf(r.delta.p95Ms)}
      />
    </TableRow>
  );
}

/**
 * The Compare tab: the last window against the one before it (route statistics, counted before
 * sampling), or two releases (stored, sampled traces). Rows sort by change; regressions are
 * highlighted.
 */
export function ComparePanel({
  mode,
  onMode,
  windowMinutes,
  releaseA,
  releaseB,
  onReleases,
  service,
}: Props) {
  const [paused] = usePaused();
  const [sort, setSort] = useState<{
    key: CompareSortKey;
    dir: "asc" | "desc";
  }>({ key: "p95Ms", dir: "desc" });
  const windowQuery = useQuery({
    queryKey: ["routes", "compare", "window", windowMinutes, service],
    queryFn: () => getRouteCompare({ windowMinutes, previous: 1, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  // Releases come newest first; until one is picked, compare the two newest.
  const seen = windowQuery.data?.releases ?? [];
  const a = releaseA ?? seen[1] ?? null;
  const b = releaseB ?? seen[0] ?? null;
  const releaseQuery = useQuery({
    queryKey: ["routes", "compare", "release", a, b, service],
    queryFn: () =>
      getRouteCompare({ releaseA: a ?? "", releaseB: b ?? "", service }),
    enabled: mode === "release" && a !== null && b !== null,
    placeholderData: keepPreviousData,
  });
  const active = mode === "window" ? windowQuery : releaseQuery;
  const data = active.data;
  const rows = useMemo(
    () => sortCompareRows(data?.routes ?? [], sort.key, sort.dir),
    [data, sort],
  );
  const regressions = rows.filter((r) => verdictOf(r) === "regression").length;
  // Names start ascending, changes with the biggest increase first.
  const sortBy = (key: CompareSortKey) =>
    setSort((s) => ({
      key,
      dir:
        s.key === key
          ? s.dir === "desc"
            ? "asc"
            : "desc"
          : key === "route"
            ? "asc"
            : "desc",
    }));

  return (
    <div className="space-y-4" data-testid="compare">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="flex items-center gap-1" aria-label="Compare what">
          <Button
            size="sm"
            variant={mode === "window" ? "default" : "outline"}
            aria-pressed={mode === "window"}
            onClick={() => onMode("window")}
          >
            Window vs previous
          </Button>
          <Button
            size="sm"
            variant={mode === "release" ? "default" : "outline"}
            aria-pressed={mode === "release"}
            onClick={() => onMode("release")}
          >
            Release vs release
          </Button>
        </fieldset>
        {mode === "release" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {(
              [
                ["Release A (before)", a, (v: string) => onReleases(v, b)],
                ["Release B (after)", b, (v: string) => onReleases(a, v)],
              ] as const
            ).map(([name, value, set]) => (
              <label key={name} className="flex items-center gap-1">
                {name}
                <select
                  value={value ?? ""}
                  onChange={(e) => set(e.target.value)}
                  className="h-7 rounded-lg border border-border bg-background px-2 text-sm"
                >
                  {value === null && <option value="">none seen</option>}
                  {[...new Set([...(value ? [value] : []), ...seen])].map(
                    (release) => (
                      <option key={release} value={release}>
                        {release}
                      </option>
                    ),
                  )}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>

      <p
        data-testid="compare-note"
        className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
      >
        {mode === "window"
          ? `The last ${windowMinutes} minutes against the ${windowMinutes} minutes before, counted before sampling.`
          : "Built from the stored traces, which are sampled: counts are of kept requests, not all requests."}
        {mode === "window" && data?.mode === "window" && data.note
          ? ` ${data.note}`
          : ""}
      </p>

      {mode === "release" && (a === null || b === null) && (
        <p className="text-sm text-muted-foreground">
          Fewer than two releases are in the stored traces. A release is a
          trace's <code>service.version</code>.
        </p>
      )}
      {active.isError && data === undefined && (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the comparison: {active.error?.message}
        </p>
      )}
      {data !== undefined && (
        <>
          <p className="text-sm" data-testid="compare-summary">
            {regressions === 0
              ? "No regressions."
              : `${regressions} ${regressions === 1 ? "route" : "routes"} regressed (p95 at least ${REGRESSION.p95Ratio * 100}% and ${REGRESSION.p95Ms} ms slower, or the error rate up ${REGRESSION.errorRate * 100} points).`}
          </p>
          <div className="rounded-lg border border-border">
            <Table data-testid="compare-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {COLUMNS.map((c) => (
                    <TableHead
                      key={c.key}
                      className={cn(c.right && "text-right")}
                      aria-sort={
                        sort.key === c.key
                          ? sort.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        title={
                          c.key === "route" ? "Sort by name" : "Sort by change"
                        }
                        onClick={() => sortBy(c.key)}
                        className="inline-flex items-center gap-1"
                      >
                        {c.label}
                        {sort.key === c.key &&
                          (sort.dir === "asc" ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          ))}
                      </button>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length > 0 ? (
                  rows.map((r) => <CompareRowView key={routeKey(r)} row={r} />)
                ) : (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={5}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No requests in either period.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
