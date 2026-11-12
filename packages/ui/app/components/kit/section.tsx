import type * as React from "react";

import { SourceLabel } from "@/components/kit/source-label";
import { cn } from "@/lib/utils";

/**
 * A bordered card with a title, an optional one-line description and the line saying where its
 * figures come from (every card says). `actions` sit at the right of the header. `flush` removes
 * the body padding so a table can touch the card's edges (the header keeps its own).
 */
export function Section({
  title,
  description,
  source,
  testId,
  className,
  children,
  actions,
  flush = false,
}: {
  title: string;
  description?: string;
  /** Where the figures come from; every card says. */
  source: string;
  testId: string;
  className?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className={cn(
        "min-w-0 rounded-lg border border-border",
        flush ? "overflow-hidden" : "space-y-3 p-4",
        className,
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-2",
          flush && "p-4 pb-3",
        )}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
          <SourceLabel className="block">{source}</SourceLabel>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
