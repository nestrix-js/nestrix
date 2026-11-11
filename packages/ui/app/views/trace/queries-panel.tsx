import { formatDuration } from "@/lib/format";
import type { RepeatedQuery } from "@/lib/trace-insights";
import { cn } from "@/lib/utils";

/**
 * Statements that run three or more times in the trace, with count and total time. Picking one
 * highlights its spans in the waterfall; picking it again clears the highlight.
 */
export function QueriesPanel({
  queries,
  pickedText,
  onPick,
}: {
  queries: RepeatedQuery[];
  pickedText: string | null;
  onPick: (text: string) => void;
}) {
  return (
    <section
      data-testid="queries-panel"
      aria-label="Repeated queries"
      className="space-y-2 rounded-lg border p-3"
    >
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Queries ({queries.length} repeated)
      </h3>
      <ul className="space-y-1">
        {queries.map((query) => (
          <li key={query.text}>
            <button
              type="button"
              data-testid="query-item"
              aria-pressed={query.text === pickedText}
              onClick={() => onPick(query.text)}
              className={cn(
                "flex w-full items-baseline gap-3 rounded-md px-2 py-1 text-left text-xs hover:bg-muted",
                query.text === pickedText && "bg-warning/15",
              )}
            >
              <span
                data-testid="query-text"
                className="min-w-0 flex-1 truncate font-mono"
                title={query.text}
              >
                {query.text}
              </span>
              <span data-testid="query-count" className="shrink-0 tabular-nums">
                {query.count}x
              </span>
              <span
                data-testid="query-total"
                className="shrink-0 tabular-nums text-muted-foreground"
              >
                {formatDuration(query.totalMs)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
