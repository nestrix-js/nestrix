import type { TraceSummary } from "@nestrix-js/protocol";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import type { DataTableFeatures } from "@/components/data-table/features";
import { BarCell } from "@/components/kit/bar-cell";
import { Chip } from "@/components/kit/chip";
import { RelativeTimeCard } from "@/components/relative-time-card";
import { formatDuration } from "@/lib/format";
import { statusTone } from "@/views/requests/requests-stats";

const helper = createColumnHelper<DataTableFeatures, TraceSummary>();

/** Column labels, for the "View" menu. */
export const columnLabels: Record<string, string> = {
  time: "Time",
  method: "Method",
  route: "Route",
  status: "Status",
  duration: "Duration",
  spans: "Spans",
  error: "Error",
  release: "Release",
  user: "User",
};

const textOrDash = (value: string | undefined) =>
  value ? (
    <span className="font-mono">{value}</span>
  ) : (
    <span className="text-muted-foreground">-</span>
  );

// Ids `method`, `route` and `status` are the URL parameter names: the table's filter state
// is keyed by them, and the server does the filtering.
const buildColumns = (maxDurationMs: number) =>
  helper.columns([
    helper.accessor("startTimeUnixMs", {
      id: "time",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Time" />
      ),
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      cell: (info) => <RelativeTimeCard timeUnixMs={info.getValue()} />,
    }),
    helper.accessor((row) => row.method, {
      id: "method",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Method" />
      ),
      enableSorting: false,
      cell: (info) => {
        const method = info.getValue();
        return method ? (
          <Chip className="font-mono">{method}</Chip>
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      },
    }),
    helper.accessor((row) => row.route ?? row.name, {
      id: "route",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Route" />
      ),
      enableSorting: false,
      enableHiding: false,
      cell: (info) => (
        <span className="inline-flex items-center gap-2">
          <Link
            to="/traces/$traceId"
            params={{ traceId: info.row.original.traceId }}
            className="max-w-[26rem] truncate font-mono font-medium underline-offset-4 hover:underline"
            title={info.row.original.traceId}
          >
            {info.getValue()}
          </Link>
          {info.row.original.hasJob ? (
            <Chip
              tone="info"
              data-testid="job-badge"
              title="This trace includes job processing"
            >
              job
            </Chip>
          ) : null}
        </span>
      ),
    }),
    helper.accessor((row) => row.statusCode, {
      id: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      enableSorting: false,
      cell: (info) => {
        const code = info.getValue();
        if (code === undefined)
          return <span className="text-muted-foreground">-</span>;
        return (
          <Chip tone={statusTone(code)} className="font-mono">
            {code}
          </Chip>
        );
      },
    }),
    helper.accessor("durationMs", {
      id: "duration",
      header: ({ column }) => (
        <div className="text-right">
          <DataTableColumnHeader column={column} title="Duration" />
        </div>
      ),
      enableSorting: false,
      enableColumnFilter: false,
      cell: (info) => (
        <BarCell
          value={info.getValue()}
          max={maxDurationMs}
          label={formatDuration(info.getValue())}
          testId="duration-bar"
        />
      ),
    }),
    helper.accessor("spanCount", {
      id: "spans",
      header: ({ column }) => (
        <div className="text-right">
          <DataTableColumnHeader column={column} title="Spans" />
        </div>
      ),
      enableSorting: false,
      enableColumnFilter: false,
      cell: (info) => (
        <span className="block text-right font-mono tabular-nums">
          {info.getValue()}
        </span>
      ),
    }),
    helper.accessor("error", {
      id: "error",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Error" />
      ),
      enableSorting: false,
      enableColumnFilter: false,
      cell: (info) =>
        info.getValue() ? (
          <Chip tone="worse">error</Chip>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    }),
    helper.accessor((row) => row.release, {
      id: "release",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Release" />
      ),
      enableSorting: false,
      enableColumnFilter: false,
      cell: (info) => textOrDash(info.getValue()),
    }),
    helper.accessor((row) => row.user, {
      id: "user",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="User" />
      ),
      enableSorting: false,
      enableColumnFilter: false,
      cell: (info) => textOrDash(info.getValue()),
    }),
  ]);

/** The release and user columns exist only while some listed trace has the value. */
export function columnsFor(
  hasRelease: boolean,
  hasUser: boolean,
  maxDurationMs = 0,
): ReturnType<typeof buildColumns>[number][] {
  const out: ReturnType<typeof buildColumns>[number][] = [];
  for (const column of buildColumns(maxDurationMs)) {
    if (column.id === "release" && !hasRelease) continue;
    if (column.id === "user" && !hasUser) continue;
    out.push(column);
  }
  return out;
}
