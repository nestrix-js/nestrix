// Slim version of tablecn's skeleton (MIT, (c) sadmann7).

import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function DataTableSkeleton({
  columnCount,
  rowCount = 8,
}: {
  columnCount: number;
  rowCount?: number;
}) {
  const columns = Array.from({ length: columnCount }, (_, i) => `c${i}`);
  const rows = Array.from({ length: rowCount }, (_, i) => `r${i}`);
  return (
    <div
      className="rounded-lg border border-border"
      data-testid="table-skeleton"
      aria-busy="true"
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => (
              <TableHead key={c}>
                <Skeleton className="h-4 w-16" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r} className="hover:bg-transparent">
              {columns.map((c) => (
                <TableCell key={c}>
                  <Skeleton className="h-4 w-full min-w-12" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
