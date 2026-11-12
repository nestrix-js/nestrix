import type * as React from "react";

import type { DonutSlice } from "@/components/kit/format";

export const DONUT_RADIUS = 54;

/**
 * A donut of arcs; `children` is the centre text. Build `slices` with `donutSlices(items,
 * DONUT_RADIUS)`. `label` states the takeaway for screen readers.
 */
export function Donut({
  slices,
  label,
  children,
  testId,
  size = 150,
}: {
  slices: readonly DonutSlice[];
  label: string;
  children: React.ReactNode;
  testId: string;
  size?: number;
}) {
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      data-testid={testId}
    >
      <svg
        viewBox="0 0 140 140"
        role="img"
        aria-label={label}
        width={size}
        height={size}
        className="-rotate-90"
      >
        <title>{label}</title>
        <circle
          cx="70"
          cy="70"
          r={DONUT_RADIUS}
          fill="none"
          stroke="var(--muted)"
          strokeWidth="18"
        />
        {slices.map((slice) => (
          <circle
            key={slice.key}
            data-testid={`${testId}-slice`}
            data-slice={slice.key}
            data-fraction={slice.fraction.toFixed(4)}
            cx="70"
            cy="70"
            r={DONUT_RADIUS}
            fill="none"
            stroke={`var(${slice.color})`}
            strokeWidth="18"
            strokeDasharray={slice.dasharray}
            strokeDashoffset={slice.dashoffset}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}

/** A small coloured square that ties a legend row to its chart colour (`color` is `--token`). */
export function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: `var(${color})` }}
    />
  );
}

export interface LegendItem {
  key: string;
  label: string;
  /** A CSS custom property. */
  color: string;
  /** The formatted value shown at the right ("42%", "1.2k"). */
  value?: string;
}

/** The legend beside a donut or under a chart: a swatch, the label and the value per row. */
export function DonutLegend({
  items,
  testId,
  rowTestId,
}: {
  items: readonly LegendItem[];
  testId?: string;
  rowTestId?: string;
}) {
  return (
    <ul data-testid={testId} className="min-w-36 flex-1 space-y-2 text-sm">
      {items.map((item) => (
        <li
          key={item.key}
          data-testid={rowTestId}
          data-key={item.key}
          className="flex items-center gap-2"
        >
          <Swatch color={item.color} />
          <span className="flex-1">{item.label}</span>
          {item.value !== undefined && (
            <span className="font-mono">{item.value}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
