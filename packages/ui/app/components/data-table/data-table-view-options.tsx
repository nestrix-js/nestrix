// Slim version of tablecn's view options (MIT, (c) sadmann7): show or hide columns.
import type { ReactTable, RowData } from "@tanstack/react-table";
import { Settings2 } from "lucide-react";

import type { DataTableFeatures } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function DataTableViewOptions<TData extends RowData>({
  table,
  labels,
}: {
  table: ReactTable<DataTableFeatures, TData>;
  /** Column id to label. */
  labels: Record<string, string>;
}) {
  const columns = table.getAllLeafColumns().filter((c) => c.getCanHide());
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <Settings2 />
        View
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44">
        {columns.map((column) => (
          <label
            key={column.id}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
          >
            <input
              type="checkbox"
              checked={column.getIsVisible()}
              onChange={(e) => column.toggleVisibility(e.target.checked)}
            />
            {labels[column.id] ?? column.id}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}
