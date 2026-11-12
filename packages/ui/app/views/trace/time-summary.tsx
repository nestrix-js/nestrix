import { Section } from "@/components/kit";
import { formatDuration } from "@/lib/format";
import { CATEGORY_LABELS, type TimeBreakdown } from "@/lib/trace-time";
import { cn } from "@/lib/utils";
import { CATEGORY_BG } from "@/views/trace/category-style";

const pctText = (pct: number) =>
  pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;

/**
 * "Where the time went": self time by category as a stacked bar with a legend, the top
 * classes or spans by self time, and the critical-path toggle.
 *
 * Markup for tests: `time-summary`, `time-bar` with one `time-segment` per category
 * (`data-category`, `data-pct`), `time-legend-item` (text: label and percentage), `time-top-item`,
 * and the `critical-path-toggle` button (`aria-pressed`).
 */
export function TimeSummary({
  breakdown,
  criticalPathOn,
  onToggleCriticalPath,
}: {
  breakdown: TimeBreakdown;
  criticalPathOn: boolean;
  onToggleCriticalPath: () => void;
}) {
  const { categories, top, totalMs } = breakdown;
  return (
    <Section
      testId="time-summary"
      title="Where the time went"
      description={`${formatDuration(totalMs)} of own time, by kind of work`}
      source="from this trace's spans"
      actions={
        <button
          type="button"
          data-testid="critical-path-toggle"
          aria-pressed={criticalPathOn}
          title="Highlight the spans that determine the trace's end time"
          onClick={onToggleCriticalPath}
          className={cn(
            "h-7 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-muted",
            criticalPathOn && "border-primary bg-primary/10",
          )}
        >
          Critical path
        </button>
      }
    >
      {categories.length === 0 ? (
        <p className="text-xs text-muted-foreground">No timing to show.</p>
      ) : (
        <>
          <div
            data-testid="time-bar"
            role="img"
            aria-label={categories
              .map((c) => `${CATEGORY_LABELS[c.category]} ${pctText(c.pct)}`)
              .join(", ")}
            className="flex h-4 w-full gap-px overflow-hidden rounded-md bg-muted"
          >
            {categories.map((c) => (
              <div
                key={c.category}
                data-testid="time-segment"
                data-category={c.category}
                data-pct={c.pct.toFixed(2)}
                className={CATEGORY_BG[c.category]}
                style={{ width: `${c.pct}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {categories.map((c) => (
              <li
                key={c.category}
                data-testid="time-legend-item"
                data-category={c.category}
                className="flex items-center gap-1.5"
              >
                <span
                  className={cn("size-2.5 rounded-sm", CATEGORY_BG[c.category])}
                />
                <span>{CATEGORY_LABELS[c.category]}</span>
                <span className="tabular-nums text-muted-foreground">
                  {pctText(c.pct)}
                </span>
              </li>
            ))}
          </ul>
          <ol className="space-y-1 border-t border-border pt-3 text-xs">
            {top.map((item) => (
              <li
                key={item.key}
                data-testid="time-top-item"
                className="flex items-center gap-3"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-2.5 shrink-0 rounded-sm",
                    CATEGORY_BG[item.category],
                  )}
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono"
                  title={item.label}
                >
                  {item.label}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {CATEGORY_LABELS[item.category]}
                </span>
                <span
                  aria-hidden
                  className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
                >
                  <span
                    className={cn("block h-full", CATEGORY_BG[item.category])}
                    style={{ width: `${Math.min(100, item.pct)}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right font-mono tabular-nums">
                  {formatDuration(item.selfMs)}
                </span>
                <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
                  {pctText(item.pct)}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Section>
  );
}
