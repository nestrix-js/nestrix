// Modelled on tablecn's faceted filter and Dice UI's faceted (MIT, (c) sadmann7), without
// cmdk (D-52 keeps it conditional): a popover with a search box and a list of options.
// The query API takes one value per parameter, so this is single-select.
import type { Column, RowData } from "@tanstack/react-table";
import { Check, PlusCircle } from "lucide-react";
import { useState } from "react";

import type { DataTableFeatures } from "@/components/data-table/features";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface FacetOption {
  label: string;
  value: string;
}

export function DataTableFacetedFilter<TData extends RowData, TValue>({
  column,
  title,
  options,
}: {
  column: Column<DataTableFeatures, TData, TValue> | undefined;
  title: string;
  options: FacetOption[];
}) {
  const [query, setQuery] = useState("");
  const selected = column?.getFilterValue() as string | undefined;
  // A value from the URL that the options do not list is still shown, so it can be cleared.
  const all =
    selected !== undefined && !options.some((o) => o.value === selected)
      ? [{ label: selected, value: selected }, ...options]
      : options;
  const shown = all.filter((o) =>
    o.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="border-dashed"
            aria-label={`${title} filter`}
          />
        }
      >
        <PlusCircle />
        {title}
        {selected !== undefined && (
          <Badge variant="secondary" className="font-mono">
            {all.find((o) => o.value === selected)?.label ?? selected}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-56">
        <div className="p-1">
          <Input
            placeholder={title}
            aria-label={`Search ${title}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div
          role="listbox"
          aria-label={title}
          className="max-h-60 overflow-y-auto"
        >
          {shown.length === 0 && (
            <p className="p-2 text-center text-sm text-muted-foreground">
              No results.
            </p>
          )}
          {shown.map((option) => {
            const isSelected = option.value === selected;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() =>
                  column?.setFilterValue(isSelected ? undefined : option.value)
                }
              >
                <Check className={cn("size-4", !isSelected && "invisible")} />
                <span className="truncate font-mono">{option.label}</span>
              </button>
            );
          })}
        </div>
        {selected !== undefined && (
          <div className="border-t border-border p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => column?.setFilterValue(undefined)}
            >
              Clear filter
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
