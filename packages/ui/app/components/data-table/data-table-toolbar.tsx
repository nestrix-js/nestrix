// Slim version of tablecn's toolbar (MIT, (c) sadmann7): the caller's filter controls, a
// reset button while any filter is set, and the column picker.
import type { ReactTable, RowData } from "@tanstack/react-table";
import { X } from "lucide-react";
import type * as React from "react";

import { DataTableViewOptions } from "@/components/data-table/data-table-view-options";
import type { DataTableFeatures } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DataTableToolbar<TData extends RowData>({
  table,
  labels,
  isFiltered,
  onReset,
  children,
  className,
}: {
  table: ReactTable<DataTableFeatures, TData>;
  labels: Record<string, string>;
  isFiltered: boolean;
  onReset: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Filters"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {children}
      {isFiltered && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          Reset
          <X />
        </Button>
      )}
      <div className="ml-auto">
        <DataTableViewOptions table={table} labels={labels} />
      </div>
    </div>
  );
}
