// Slim version of tablecn's column header (MIT, (c) sadmann7). The query API has no sort
// parameter yet, so no column enables sorting and the header is a title; a column that does
// enable it gets the toggle, and the caller maps `sorting` state to a server parameter.
import type { Column, RowData } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import type { DataTableFeatures } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";

export function DataTableColumnHeader<TData extends RowData, TValue>({
  column,
  title,
}: {
  column: Column<DataTableFeatures, TData, TValue>;
  title: string;
}) {
  if (!column.getCanSort()) return <span>{title}</span>;
  const sorted = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2.5"
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      {title}
      {sorted === "desc" ? (
        <ArrowDown />
      ) : sorted === "asc" ? (
        <ArrowUp />
      ) : (
        <ChevronsUpDown />
      )}
    </Button>
  );
}
