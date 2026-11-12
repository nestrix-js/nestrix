import { Link } from "@tanstack/react-router";
import type * as React from "react";

import { type StackSegment, stackHeights } from "@/components/kit/format";
import { cn } from "@/lib/utils";

export interface BarItem {
  key: string;
  label: string;
  /** Base first; later segments stack on top (a normal part, then the errors). */
  segments: readonly StackSegment[];
  /** Tooltip. */
  title?: string;
  /** Horizontal bars only: the text at the right ("1.2 s"). */
  valueLabel?: string;
  /** Horizontal bars only: makes the label a link (a router path, with `search` for its query). */
  to?: string;
  search?: Record<string, string>;
  /** Extra `data-*` attributes on the bar, for tests. */
  attrs?: Record<`data-${string}`, string | number>;
}

/**
 * Bars in plain HTML. Vertical: one column per item, rising from a shared baseline (a time series
 * of buckets). Horizontal: one row per item with its label and value (a ranking). Segments stack,
 * so "requests, errors on top" is one item with two segments. Every bar is scaled to `max` (the
 * largest total by default). `label` states the takeaway for screen readers.
 */
export function BarChart({
  items,
  orientation = "vertical",
  max,
  label,
  testId,
  barTestId,
  heightClass = "h-36",
  labelWidthClass = "w-40",
}: {
  items: readonly BarItem[];
  orientation?: "vertical" | "horizontal";
  max?: number;
  label: string;
  testId?: string;
  barTestId?: string;
  /** Vertical only. */
  heightClass?: string;
  /** Horizontal only: the label column's width. */
  labelWidthClass?: string;
}) {
  const total = (item: BarItem) =>
    item.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const scale = max ?? Math.max(1, ...items.map(total));
  const fill = (
    s: StackSegment & { percent: number },
  ): React.CSSProperties => ({
    background: `var(${s.color})`,
    opacity: s.opacity,
  });

  if (orientation === "vertical") {
    return (
      <div
        role="img"
        aria-label={label}
        data-testid={testId}
        className={cn("flex items-end gap-0.5", heightClass)}
      >
        {items.map((item) => {
          const parts = stackHeights(item.segments, scale);
          return (
            <div
              key={item.key}
              data-testid={barTestId}
              title={item.title}
              className="flex h-full flex-1 flex-col justify-end"
              {...item.attrs}
            >
              {[...parts].reverse().map((p, i) => (
                <div
                  key={p.label ?? p.color}
                  className={cn(i === 0 && "rounded-t-sm")}
                  style={{ ...fill(p), height: `${p.percent}%`, minHeight: 2 }}
                />
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <ul aria-label={label} data-testid={testId} className="space-y-2">
      {items.map((item) => {
        const parts = stackHeights(item.segments, scale);
        const text = (
          <span className="truncate font-mono text-xs">{item.label}</span>
        );
        return (
          <li
            key={item.key}
            data-testid={barTestId}
            title={item.title}
            className="flex items-center gap-3"
            {...item.attrs}
          >
            <span className={cn("shrink-0 truncate", labelWidthClass)}>
              {item.to ? (
                <Link
                  to={item.to}
                  search={item.search as never}
                  className="underline-offset-4 hover:underline"
                >
                  {text}
                </Link>
              ) : (
                text
              )}
            </span>
            <span
              aria-hidden
              className="flex h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
            >
              {parts.map((p) => (
                <span
                  key={p.label ?? p.color}
                  className="h-full"
                  style={{ ...fill(p), width: `${p.percent}%` }}
                />
              ))}
            </span>
            <span className="w-16 shrink-0 text-right font-mono text-xs">
              {item.valueLabel ?? ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
