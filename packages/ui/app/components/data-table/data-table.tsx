// Slim version of tablecn's data table (https://github.com/sadmann7/tablecn, MIT,
// (c) sadmann7): rendering only. State, filters and the toolbar come from the caller.
import type { ReactTable, RowData } from "@tanstack/react-table";
import type * as React from "react";

import type { DataTableFeatures } from "@/components/data-table/features";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface DataTableProps<TData extends RowData> {
  table: ReactTable<DataTableFeatures, TData>;
  testId?: string;
  /** Shown when there are no rows. */
  empty?: React.ReactNode;
  /** The toolbar, above the table. */
  toolbar?: React.ReactNode;
  /** Pagination or "load older", below the table. */
  footer?: React.ReactNode;
}

export function DataTable<TData extends RowData>({
  table,
  testId,
  empty,
  toolbar,
  footer,
}: DataTableProps<TData>) {
  const rows = table.getRowModel().rows;
  const columnCount = table.getVisibleLeafColumns().length;
  return (
    <div className="space-y-3">
      {toolbar}
      <div className="rounded-lg border border-border">
        <Table data-testid={testId}>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={columnCount}
                  className="h-24 text-center text-muted-foreground"
                >
                  {empty ?? "No results."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {footer}
    </div>
  );
}
