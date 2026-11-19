import type { LogSearchRecord } from "@nestrix-js/protocol";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { Chip } from "@/components/kit/chip";
import { PageHeader } from "@/components/kit/page-header";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { SkeletonList } from "@/components/kit/skeletons";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { getLogs, getMeta } from "@/lib/api";
import { useService } from "@/lib/service";
import { logLevelLabel, logTone, toneClass } from "@/lib/trace-logs";
import { cn } from "@/lib/utils";
import {
  DEFAULT_LOG_FILTERS,
  dropSummary,
  isTraceId,
  LOG_SEVERITIES,
  LOG_WINDOWS,
  type LogFilters,
  logClock,
  logQuery,
} from "@/views/logs/logs-query";

/**
 * Log search (issue #17, D-106), standalone server only. Filters apply with the Search button (or
 * Enter); the window ends at the moment of the search so "Load older" pages stay stable, and
 * Reload moves it to now.
 *
 * Markup for tests: `logs-page`, `logs-form` (`logs-text`, `logs-match`, `logs-severity`,
 * `logs-window`, `logs-trace`, `logs-search`), `logs-capture`, `logs-dropped`, `log-row` with
 * `data-tone`, `log-time`, `log-level`, `log-service`, `log-message`, `log-truncated`,
 * `log-trace-link`, `logs-older`, `logs-empty`.
 */
const FIELD = "h-8 rounded-lg border border-border bg-background px-2 text-sm";

export function LogsPage() {
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const [service] = useService();
  const [draft, setDraft] = useState<LogFilters>(DEFAULT_LOG_FILTERS);
  const [applied, setApplied] = useState<{ filters: LogFilters; at: number }>(
    () => ({ filters: DEFAULT_LOG_FILTERS, at: Date.now() }),
  );
  const filters = { ...applied.filters, service };
  const params = logQuery(filters, applied.at);

  const logs = useInfiniteQuery({
    queryKey: ["logs", params],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getLogs({ ...params, before: pageParam }),
    getNextPageParam: (last) => last.older ?? undefined,
    enabled: meta.data?.mode === "standalone",
  });

  if (meta.data !== undefined && meta.data.mode !== "standalone") {
    return (
      <div data-testid="logs-page" className="space-y-4">
        <PageHeader
          title="Logs"
          description="Search the log lines the server stores."
        />
        <EmptyState title="Log search needs the standalone server">
          The embedded dashboard shows log lines next to a trace only.
        </EmptyState>
      </div>
    );
  }

  const apply = () => {
    setApplied({ filters: draft, at: Date.now() });
  };
  const items: LogSearchRecord[] =
    logs.data?.pages.flatMap((p) => p.items) ?? [];
  const first = logs.data?.pages[0];
  const dropped = first ? dropSummary(first.dropped) : null;
  const traceOk = isTraceId(draft.traceId);

  return (
    <div data-testid="logs-page" className="space-y-4">
      <PageHeader
        title="Logs"
        description="Search the log lines stored by the server, newest first"
        source="from stored log lines"
        controls={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Reload"
            onClick={() =>
              setApplied({ filters: applied.filters, at: Date.now() })
            }
          >
            <RefreshCw />
            Reload
          </Button>
        }
      />
      <form
        data-testid="logs-form"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (traceOk) apply();
        }}
      >
        <input
          data-testid="logs-text"
          aria-label="Text"
          placeholder="Search text"
          maxLength={200}
          value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          className={cn(FIELD, "w-64")}
        />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            data-testid="logs-match"
            type="checkbox"
            checked={draft.match === "substring"}
            onChange={(e) =>
              setDraft({
                ...draft,
                match: e.target.checked ? "substring" : "words",
              })
            }
          />
          Substring
        </label>
        <Select
          data-testid="logs-severity"
          aria-label="Minimum level"
          value={draft.severity}
          onChange={(e) =>
            setDraft({
              ...draft,
              severity: e.target.value as LogFilters["severity"],
            })
          }
        >
          <option value="">Any level</option>
          {LOG_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s} and above
            </option>
          ))}
        </Select>
        <div data-testid="logs-window">
          <SegmentedControl
            label="Time range"
            options={LOG_WINDOWS.map((w) => ({ value: w.id, label: w.id }))}
            value={draft.window}
            onChange={(window) => setDraft({ ...draft, window })}
          />
        </div>
        <input
          data-testid="logs-trace"
          aria-label="Trace id"
          aria-invalid={!traceOk}
          placeholder="Trace id"
          maxLength={32}
          value={draft.traceId}
          onChange={(e) => setDraft({ ...draft, traceId: e.target.value })}
          className={cn(
            FIELD,
            "w-full font-mono sm:w-72",
            !traceOk && "border-destructive",
          )}
        />
        <Button
          data-testid="logs-search"
          type="submit"
          size="sm"
          disabled={!traceOk}
        >
          Search
        </Button>
      </form>

      {first && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Chip data-testid="logs-capture" tone="neutral">
            {first.capture === "all"
              ? "storing all log lines"
              : "storing lines with a trace id only"}
          </Chip>
          {dropped && (
            <Chip data-testid="logs-dropped" tone="warn" wrap>
              {dropped}
            </Chip>
          )}
        </div>
      )}

      {logs.isError ? (
        <ErrorState
          title="Could not search the logs."
          message={logs.error.message}
          onRetry={() => void logs.refetch()}
        />
      ) : logs.isPending ? (
        <SkeletonList rows={6} />
      ) : items.length === 0 ? (
        <EmptyState testId="logs-empty" title="No log lines match">
          {first?.capture === "trace"
            ? "This server stores only lines that carry a trace id. Start it with NESTRIX_LOGS=all to keep every line."
            : "Try a wider time range or fewer filters."}
        </EmptyState>
      ) : (
        <>
          <ol
            data-testid="logs-list"
            className="divide-y divide-border rounded-lg border border-border font-mono text-xs"
          >
            {items.map((line) => (
              <LogRow key={line.id} line={line} />
            ))}
          </ol>
          {logs.hasNextPage && (
            <Button
              data-testid="logs-older"
              variant="outline"
              disabled={logs.isFetchingNextPage}
              onClick={() => void logs.fetchNextPage()}
            >
              {logs.isFetchingNextPage ? "Loading…" : "Load older lines"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function LogRow({ line }: { line: LogSearchRecord }) {
  const tone = logTone(line.severity);
  return (
    <li
      data-testid="log-row"
      data-tone={tone}
      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5"
    >
      <span
        data-testid="log-time"
        className="tabular-nums text-muted-foreground"
      >
        {logClock(line.timeUnixMs)}
      </span>
      <span
        data-testid="log-level"
        className={cn("w-12 uppercase", toneClass(tone))}
      >
        {logLevelLabel(line)}
      </span>
      <span data-testid="log-service" className="text-muted-foreground">
        {line.service}
        {line.context ? ` · ${line.context}` : ""}
      </span>
      <span
        data-testid="log-message"
        className="min-w-0 basis-full whitespace-pre-wrap break-words sm:flex-1 sm:basis-0"
      >
        {line.message}
      </span>
      {line.truncated && (
        <Chip data-testid="log-truncated" tone="warn">
          cut at 8,192 characters
        </Chip>
      )}
      {line.traceId !== undefined &&
        (line.traceExists ? (
          <Link
            data-testid="log-trace-link"
            to="/traces/$traceId"
            params={{ traceId: line.traceId }}
            className="text-info underline-offset-2 hover:underline"
          >
            View trace
          </Link>
        ) : (
          <span
            data-testid="log-trace-missing"
            className="text-muted-foreground"
            title={line.traceId}
          >
            trace not stored
          </span>
        ))}
    </li>
  );
}
