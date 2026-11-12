import { Info } from "lucide-react";

import {
  bannerHeadline,
  MAX_SPANS_DOCS_URL,
  type OmittedSummary,
  splitLine,
} from "@/lib/trace-omitted";

/** Shown above the waterfall when spans of this trace were counted but not recorded. */
export function OmittedBanner({ summary }: { summary: OmittedSummary }) {
  return (
    <div
      role="status"
      data-testid="omitted-banner"
      className="flex gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm"
    >
      <Info
        className="mt-0.5 size-4 shrink-0 text-warning"
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-1">
        <p className="font-medium" data-testid="omitted-headline">
          {bannerHeadline(summary.total)}
        </p>
        <p data-testid="omitted-split" className="text-muted-foreground">
          {splitLine(summary)}
        </p>
        {summary.kinds.length > 0 ? (
          <ul
            data-testid="omitted-kinds"
            className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground"
          >
            {summary.kinds.map((k) => (
              <li key={k.key} data-kind={k.key}>
                {k.label}: <span className="tabular-nums">{k.count}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p>
          <a
            href={MAX_SPANS_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="omitted-docs-link"
            className="underline underline-offset-4"
          >
            About the maxSpansPerTrace option
          </a>
        </p>
      </div>
    </div>
  );
}
