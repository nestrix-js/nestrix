import type { TraceSummary } from "@nestrix/protocol";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import type { DataTableFeatures } from "@/components/data-table/features";
import { RelativeTimeCard } from "@/components/relative-time-card";
import { Badge } from "@/components/ui/badge";
import { formatDuration } from "@/lib/format";

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
};

// Ids `method`, `route` and `status` are the URL parameter names: the table's filter state
// is keyed by them, and the server does the filtering.
export const columns = helper.columns([
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
        <Badge variant="outline" className="font-mono">
          {method}
        </Badge>
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
      <Link
        to="/traces/$traceId"
        params={{ traceId: info.row.original.traceId }}
        className="font-mono underline-offset-4 hover:underline"
        title={info.row.original.traceId}
      >
        {info.getValue()}
      </Link>
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
        <Badge
          variant={
            code >= 500 ? "destructive" : code >= 400 ? "secondary" : "outline"
          }
          className="font-mono"
        >
          {code}
        </Badge>
      );
    },
  }),
  helper.accessor("durationMs", {
    id: "duration",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Duration" />
    ),
    enableSorting: false,
    enableColumnFilter: false,
    cell: (info) => (
      <span className="font-mono">{formatDuration(info.getValue())}</span>
    ),
  }),
  helper.accessor("spanCount", {
    id: "spans",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Spans" />
    ),
    enableSorting: false,
    enableColumnFilter: false,
    cell: (info) => <span className="font-mono">{info.getValue()}</span>,
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
        <Badge variant="destructive">error</Badge>
      ) : (
        <span className="text-muted-foreground">-</span>
      ),
  }),
]);
