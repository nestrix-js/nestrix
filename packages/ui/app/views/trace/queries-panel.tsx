import { Section } from "@/components/kit";
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
    <Section
      testId="queries-panel"
      title={`Queries (${queries.length} repeated)`}
      description="Statements that ran three or more times; pick one to highlight its spans"
      source="from this trace's spans"
    >
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
              <span
                data-testid="query-count"
                className="shrink-0 font-mono tabular-nums"
              >
                {query.count}x
              </span>
              <span
                data-testid="query-total"
                className="shrink-0 font-mono tabular-nums text-muted-foreground"
              >
                {formatDuration(query.totalMs)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
