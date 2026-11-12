import type * as React from "react";

import { SourceLabel } from "@/components/kit/source-label";

/**
 * The header every page starts with: the title, one line on what the page answers, where its
 * numbers come from (`source`: a `SourceKind` for the standard wording, or your own text), and
 * on the right the page's controls (window toggle, filters, actions).
 */
export function PageHeader({
  title,
  description,
  source,
  controls,
}: {
  title: string;
  description: string;
  source?: string;
  controls?: React.ReactNode;
}) {
  return (
    <header
      data-testid="page-header"
      className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
    >
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">
          {description}
          {source && (
            <>
              {" "}
              <span aria-hidden>·</span>{" "}
              {source === "stats" || source === "traces" ? (
                <SourceLabel kind={source} className="text-sm" />
              ) : (
                <SourceLabel className="text-sm">{source}</SourceLabel>
              )}
            </>
          )}
        </p>
      </div>
      {controls && (
        <div className="flex flex-wrap items-center gap-2">{controls}</div>
      )}
    </header>
  );
}
