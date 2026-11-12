import type { TraceLogRecord } from "@nestrix-js/protocol";

import { formatDuration } from "@/lib/format";
import {
  logLevelLabel,
  logOffsetMs,
  logTone,
  toneClass,
} from "@/lib/trace-logs";
import { cn } from "@/lib/utils";

/**
 * The trace's log lines in time order (P9-07): offset from the trace's start, level coloured by
 * severity, logger context, message. A line written under a span of this trace is a button that
 * selects that span in the waterfall; the selected span's lines are highlighted.
 *
 * Markup for tests: `section[data-testid="logs-panel"]`; each line is `[data-testid="log-line"]`
 * with `data-span-id` (when it has one), `data-tone` (trace, debug, info, warn, error, fatal,
 * unknown) and `data-selected="true"` for lines of the selected span; inside, `log-time`,
 * `log-level`, `log-context`, `log-message`. `logs-truncated` says the per-trace cap was reached.
 */
export function LogsPanel({
  logs,
  truncated,
  traceStartMs,
  spanIds,
  selectedSpanId,
  onSelectSpan,
}: {
  logs: readonly TraceLogRecord[];
  truncated: boolean;
  traceStartMs: number;
  /** Spans of this trace: a line naming another span is not clickable. */
  spanIds: ReadonlySet<string>;
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
}) {
  return (
    <section
      data-testid="logs-panel"
      aria-label="Logs"
      className="space-y-2 rounded-lg border p-3"
    >
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Logs ({logs.length})
      </h3>
      <ol className="max-h-80 space-y-px overflow-auto font-mono text-xs">
        {logs.map((line, i) => {
          const tone = logTone(line.severity);
          const linked =
            line.spanId !== undefined && spanIds.has(line.spanId)
              ? line.spanId
              : undefined;
          const selected = linked !== undefined && linked === selectedSpanId;
          const content = (
            <>
              <span
                data-testid="log-time"
                className="w-20 shrink-0 text-right tabular-nums text-muted-foreground"
              >
                +{formatDuration(Math.max(0, logOffsetMs(line, traceStartMs)))}
              </span>
              <span
                data-testid="log-level"
                className={cn("w-12 shrink-0 font-medium", toneClass(tone))}
              >
                {logLevelLabel(line)}
              </span>
              {line.context ? (
                <span
                  data-testid="log-context"
                  className="max-w-40 shrink-0 truncate text-muted-foreground"
                  title={line.context}
                >
                  [{line.context}]
                </span>
              ) : null}
              <span
                data-testid="log-message"
                className="min-w-0 flex-1 whitespace-pre-wrap break-words"
              >
                {line.message}
              </span>
            </>
          );
          const common = {
            "data-testid": "log-line",
            "data-span-id": line.spanId,
            "data-tone": tone,
            "data-selected": selected ? "true" : undefined,
            className: cn(
              "flex w-full items-baseline gap-2 rounded px-2 py-0.5 text-left",
              (tone === "error" || tone === "fatal") && "bg-destructive/5",
              selected && "bg-muted",
            ),
          };
          return (
            // Lines have no id; their position in the trace's time-ordered list is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={i}>
              {linked !== undefined ? (
                <button
                  type="button"
                  {...common}
                  className={cn(common.className, "hover:bg-muted/60")}
                  title="Show this line's span"
                  onClick={() => onSelectSpan(linked)}
                >
                  {content}
                </button>
              ) : (
                <div {...common}>{content}</div>
              )}
            </li>
          );
        })}
      </ol>
      {truncated ? (
        <p
          data-testid="logs-truncated"
          className="text-xs text-muted-foreground"
        >
          More lines were written for this trace than are kept (200 at most).
        </p>
      ) : null}
    </section>
  );
}
