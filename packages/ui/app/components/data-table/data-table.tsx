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
import { cn } from "@/lib/utils";

interface DataTableProps<TData extends RowData> {
  table: ReactTable<DataTableFeatures, TData>;
  testId?: string;
  /** Shown when there are no rows. */
  empty?: React.ReactNode;
  /** The toolbar, above the table. */
  toolbar?: React.ReactNode;
  /** Pagination or "load older", below the table. */
  footer?: React.ReactNode;
  /** Makes the whole row clickable (a mouse convenience: keep a real link inside the row). */
  onRowClick?: (row: TData) => void;
  /** Classes of the table's scrolling box; a max height makes the header stick while scrolling. */
  containerClassName?: string;
}

export function DataTable<TData extends RowData>({
  table,
  testId,
  empty,
  toolbar,
  footer,
  onRowClick,
  containerClassName,
}: DataTableProps<TData>) {
  const rows = table.getRowModel().rows;
  const columnCount = table.getVisibleLeafColumns().length;
  return (
    <div className="space-y-3">
      {toolbar}
      <div className="overflow-hidden rounded-lg border border-border">
        <Table data-testid={testId} containerClassName={containerClassName}>
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
                <TableRow
                  key={row.id}
                  className={cn(onRowClick && "cursor-pointer")}
                  onClick={
                    onRowClick
                      ? (event) => {
                          // A click on a link, button or field inside the row belongs to that control.
                          const target = event.target as Element;
                          if (
                            target.closest(
                              "a, button, input, select, textarea, label",
                            )
                          )
                            return;
                          onRowClick(row.original);
                        }
                      : undefined
                  }
                >
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
