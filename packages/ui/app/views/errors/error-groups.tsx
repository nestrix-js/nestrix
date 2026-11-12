import type { ErrorGroup } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { RelativeTimeCard } from "@/components/relative-time-card";
import { Sparkline } from "@/components/sparkline";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getErrorGroups } from "@/lib/api";
import { pollInterval, usePaused } from "@/lib/live";
import { useService } from "@/lib/service";

const WINDOWS = [15, 60] as const;
const COLUMNS = 6;

function GroupRow({
  group,
  windowMinutes,
}: {
  group: ErrorGroup;
  windowMinutes: number;
}) {
  const [open, setOpen] = useState(false);
  const detailId = `error-group-${group.exampleTraceId}`;
  const shown = group.pattern || group.latestMessage || "-";
  return (
    <>
      <TableRow data-testid="error-group-row">
        <TableCell className="text-right font-mono" data-testid="group-count">
          {group.count}
        </TableCell>
        <TableCell className="max-w-md">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            title={open ? "Hide the occurrences" : "Show the occurrences"}
            onClick={() => setOpen(!open)}
            className="flex w-full items-start gap-1 text-left"
          >
            {open ? (
              <ChevronDown
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
            ) : (
              <ChevronRight
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
            )}
            <span className="min-w-0">
              <span className="block font-mono">{group.errorType ?? "-"}</span>
              <span
                className="block truncate text-xs text-muted-foreground"
                data-testid="group-pattern"
              >
                {shown}
              </span>
            </span>
          </button>
        </TableCell>
        <TableCell>
          <Sparkline
            values={group.series}
            label={`${group.count} in the last ${windowMinutes} minutes`}
          />
        </TableCell>
        <TableCell>
          <RelativeTimeCard timeUnixMs={group.firstSeenUnixMs} />
        </TableCell>
        <TableCell>
          <RelativeTimeCard timeUnixMs={group.lastSeenUnixMs} />
        </TableCell>
        <TableCell>
          {group.route ? (
            <span className="font-mono">{group.route}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow
          className="hover:bg-transparent"
          data-testid="error-group-detail"
        >
          <TableCell id={detailId} colSpan={COLUMNS} className="bg-muted/30">
            {group.services.length > 0 && (
              <p className="mb-2 text-xs text-muted-foreground">
                Services: {group.services.join(", ")}
              </p>
            )}
            <p className="mb-1 text-xs text-muted-foreground">
              Recent occurrences (latest {group.recent.length} of {group.count})
            </p>
            <ul className="space-y-1">
              {group.recent.map((o) => (
                <li
                  key={`${o.traceId}-${o.spanId}`}
                  data-testid="group-occurrence"
                  className="flex flex-wrap items-baseline gap-x-3 text-sm"
                >
                  <RelativeTimeCard timeUnixMs={o.timeUnixMs} />
                  {o.service && (
                    <span className="text-xs text-muted-foreground">
                      {o.service}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {o.message ?? "-"}
                  </span>
                  <Link
                    to="/traces/$traceId"
                    params={{ traceId: o.traceId }}
                    title={o.traceId}
                    className="underline-offset-4 hover:underline"
                  >
                    View trace
                  </Link>
                </li>
              ))}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** The errors of the last 15 or 60 minutes grouped by type, normalised message and route. */
export function ErrorGroups() {
  const [windowMinutes, setWindowMinutes] = useState<number>(WINDOWS[0]);
  const [service] = useService();
  const [paused] = usePaused();
  const groups = useQuery({
    queryKey: ["errors", "groups", windowMinutes, service],
    queryFn: () => getErrorGroups({ windowMinutes, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const shownWindow = groups.data?.windowMinutes ?? windowMinutes;
  return (
    <div className="space-y-4" data-testid="errors-grouped">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          data-testid="groups-note"
          className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
        >
          Grouped from the stored traces, which are sampled: counts cover the
          errors in stored traces, last {shownWindow} minutes, not every error
          that happened.
        </p>
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
                onClick={() => setWindowMinutes(minutes)}
              >
                {minutes} min
              </Button>
            ))}
          </fieldset>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Reload"
            onClick={() => void groups.refetch()}
          >
            <RefreshCw />
            Reload
          </Button>
        </div>
      </div>

      {groups.isPending && <DataTableSkeleton columnCount={COLUMNS} />}
      {groups.isError && groups.data === undefined && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not load error groups.</p>
          <p className="text-sm text-muted-foreground">
            {groups.error?.message}
          </p>
          <Button variant="outline" onClick={() => void groups.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {groups.data !== undefined && (
        <div className="rounded-lg border border-border">
          <Table data-testid="error-groups">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-right">Count</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Trend</TableHead>
                <TableHead>First seen</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Route</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.data.groups.length > 0 ? (
                groups.data.groups.map((g) => (
                  <GroupRow key={g.key} group={g} windowMinutes={shownWindow} />
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={COLUMNS}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No errors in the last {shownWindow} minutes.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
