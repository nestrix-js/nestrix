import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** The stand-in for one `StatTile` while its data loads. */
export function SkeletonStatTile() {
  return (
    <div
      aria-hidden
      className="flex flex-col gap-2 rounded-lg border border-border p-4"
    >
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

/** The stand-in for a `KpiStrip`: `count` tiles in the same grid. */
export function SkeletonKpiStrip({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      data-testid="skeleton-kpis"
      aria-busy="true"
      className={cn("grid grid-cols-2 gap-4 lg:grid-cols-4", className)}
    >
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <SkeletonStatTile key={i} />
      ))}
    </div>
  );
}

/** The stand-in for a chart: a card-shaped block of the chart's height. */
export function SkeletonChart({
  heightClass = "h-40",
  className,
}: {
  heightClass?: string;
  className?: string;
}) {
  return (
    <div
      data-testid="skeleton-chart"
      aria-busy="true"
      className={cn("space-y-3 rounded-lg border border-border p-4", className)}
    >
      <Skeleton className="h-4 w-40" />
      <Skeleton className={cn("w-full", heightClass)} />
    </div>
  );
}

/** The stand-in for a list of rows (an insight list, a ranking). */
export function SkeletonList({
  rows = 4,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      data-testid="skeleton-list"
      aria-busy="true"
      className={cn("space-y-3 rounded-lg border border-border p-4", className)}
    >
      <Skeleton className="h-4 w-32" />
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}
