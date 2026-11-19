import type * as React from "react";

import { Delta, isUnknownDelta } from "@/components/kit/delta";
import type { Tone } from "@/components/kit/format";
import {
  usePageSourceKind,
  withoutPageSource,
} from "@/components/kit/page-source";
import { TrendLine } from "@/components/kit/trend-line";
import { cn } from "@/lib/utils";

const tileColor: Record<Tone, string> = {
  worse: "--destructive",
  better: "--success",
  neutral: "--chart-1",
};

/**
 * One headline number: label, the change against the previous window (omit `delta` when the
 * API gives none), value with its unit, a trend line when a series exists, and the source line.
 * Never invent a change. "—" means unknown: no change is drawn, and `deltaTitle` (why there is
 * none) becomes the tooltip of the label.
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
  /** Formatted change ("+12%"); omit (or "—") for no change shown. */
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
  const page = usePageSourceKind();
  const shownSource =
    source === undefined ? undefined : withoutPageSource(source, page);
  const unknown = delta !== undefined && isUnknownDelta(delta);
  return (
    <div
      data-testid={testId}
      data-delta={unknown ? "unknown" : undefined}
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <span
          title={unknown ? deltaTitle : undefined}
          className="truncate text-xs text-muted-foreground"
        >
          {label}
        </span>
        {delta !== undefined && !unknown && (
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
      {shownSource && (
        <span className="break-words text-xs text-muted-foreground">
          {shownSource}
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
