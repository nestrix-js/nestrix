import type * as React from "react";

import { Delta } from "@/components/kit/delta";
import type { Tone } from "@/components/kit/format";
import { TrendLine } from "@/components/kit/trend-line";
import { cn } from "@/lib/utils";

const tileColor: Record<Tone, string> = {
  worse: "--destructive",
  better: "--success",
  neutral: "--chart-1",
};

/**
 * One headline number: label, the change against the previous window (omit `delta` when the
 * API gives none; pass "—" for unknown), value with its unit, a trend line when a series exists,
 * and the source line. Never invent a change; "—" is the honest answer.
 */
export function StatTile({
  testId,
  label,
  value,
  unit,
  delta,
  deltaTone = "neutral",
  deltaTitle,
  series,
  seriesColor,
  seriesLabel,
  source,
  footer,
}: {
  testId: string;
  label: string;
  value: string;
  unit?: string;
  /** Formatted change ("+12%"); "—" for unknown; omit for no change row. */
  delta?: string;
  deltaTone?: Tone;
  /** Tooltip of an unknown change (why there is none). */
  deltaTitle?: string;
  /** One value per bucket; empty or omitted for no trend line. */
  series?: readonly number[];
  /** A CSS custom property; defaults to the colour of `deltaTone`. */
  seriesColor?: string;
  seriesLabel?: string;
  /** Where the number comes from ("counted before sampling"). */
  source?: string;
  /** Anything extra under the trend (a link, a second line). */
  footer?: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        {delta !== undefined && (
          <Delta text={delta} tone={deltaTone} title={deltaTitle} />
        )}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span data-testid="kpi-value" className="text-2xl font-semibold">
          {value}
        </span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      {series && series.length > 0 && (
        <TrendLine
          values={series}
          color={seriesColor ?? tileColor[deltaTone]}
          label={seriesLabel ?? `${label} over the window`}
          width={200}
          height={32}
          area
          stretch
        />
      )}
      {footer}
      {source && (
        <span className="break-words text-xs text-muted-foreground">
          {source}
        </span>
      )}
    </div>
  );
}

const columnClass = {
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
} as const;

/** The row of `StatTile`s at the top of a page: 2 columns on a phone, `columns` on a wide screen. */
export function KpiStrip({
  children,
  columns = 4,
  className,
}: {
  children: React.ReactNode;
  columns?: keyof typeof columnClass;
  className?: string;
}) {
  return (
    <div
      data-testid="kpi-strip"
      className={cn("grid grid-cols-2 gap-4", columnClass[columns], className)}
    >
      {children}
    </div>
  );
}
