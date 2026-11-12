// biome-ignore-all lint/a11y/useSemanticElements: a virtualised treegrid positions its rows absolutely, which table elements cannot do
// biome-ignore-all lint/a11y/useFocusableInteractive: the treegrid is the single focus stop; rows are reached with the arrow keys (aria-activedescendant)
import type { TraceLogsResponse, TraceResponse } from "@nestrix-js/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CornerUpRight,
  ScrollText,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Section } from "@/components/kit";
import { formatDuration } from "@/lib/format";
import { isSlowDbSpan, repeatedQueries } from "@/lib/trace-insights";
import {
  logsBySpan,
  logTone,
  type SpanLogSummary,
  toneClass,
} from "@/lib/trace-logs";
import { omittedLabel } from "@/lib/trace-omitted";
import { categoryOf, criticalPath, timeBreakdown } from "@/lib/trace-time";
import {
  barLayout,
  buildTree,
  flattenRows,
  isErrorSpan,
  type NavKey,
  navigate,
  type Row,
  scaleTicks,
} from "@/lib/trace-tree";
import { cn } from "@/lib/utils";
import { CATEGORY_BG } from "@/views/trace/category-style";
import { LogsPanel } from "@/views/trace/logs-panel";
import { QueriesPanel } from "@/views/trace/queries-panel";
import { SpanDetail } from "@/views/trace/span-detail";
import { TimeSummary } from "@/views/trace/time-summary";

const ROW_HEIGHT = 28;
const MAX_HEIGHT = 560;
const INDENT_PX = 14;
const MAX_INDENT_LEVELS = 24;
const NAV_KEYS = new Set<string>([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

const rowDomId = (spanId: string) => `span-row-${spanId}`;
/** Log ticks drawn on one row at most; a span with more shows the count only. */
const MAX_LOG_TICKS = 50;

/**
 * The trace waterfall and its detail panel.
 *
 * Markup for tests: the container is `role="treegrid"` (`data-testid="waterfall"`); each
 * rendered row is `role="row"` with `data-testid="span-row"`, `aria-level` (1-based depth),
 * `data-depth` (0-based), `data-span-id`, `aria-expanded` (only on spans with children),
 * `aria-selected`, `data-error="true"` on error spans, `data-slow="true"` on database spans
 * over 100 ms, `data-highlighted="true"` on the spans of the statement picked in the Queries
 * panel, `data-critical="true"` on the critical path while it is switched on, and
 * `data-orphan="true"` on spans whose parent is missing. The span name is `[data-testid="span-name"]`. Only visible rows (plus a
 * small overscan) are in the DOM; `aria-rowcount` is the number of rows after collapsing.
 *
 * With `logs` (P9-07), a row whose span wrote log lines shows `[data-testid="log-marker"]` (the
 * count, `data-tone` of the most severe line) and one `[data-testid="log-tick"]` per line on the
 * time axis; the Logs panel below lists the lines, and picking one selects its span.
 */
export function Waterfall({
  trace,
  logs,
  omitted,
}: {
  trace: TraceResponse;
  logs?: TraceLogsResponse | undefined;
  /** Spans counted but not recorded (`droppedSpans.total`): adds the "(omitted N spans)" row under the root. */
  omitted?: number | undefined;
}) {
  const tree = useMemo(
    () => buildTree(trace.spans, trace.rootSpanId),
    [trace.spans, trace.rootSpanId],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const rows = useMemo(() => flattenRows(tree, collapsed), [tree, collapsed]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [pickedQuery, setPickedQuery] = useState<string | null>(null);
  const [criticalOn, setCriticalOn] = useState(false);
  const breakdown = useMemo(() => timeBreakdown(tree), [tree]);
  const critical = useMemo(
    () => new Set(criticalOn ? criticalPath(tree, trace.rootSpanId) : []),
    [criticalOn, tree, trace.rootSpanId],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const queries = useMemo(() => repeatedQueries(trace.spans), [trace.spans]);
  const picked = queries.find((q) => q.text === pickedQuery);
  const highlighted = useMemo(() => new Set(picked?.spanIds ?? []), [picked]);
  const logLines = logs?.items;
  const spanLogs = useMemo(() => logsBySpan(logLines ?? []), [logLines]);
  const spanIds = useMemo(
    () => new Set(trace.spans.map((s) => s.spanId)),
    [trace.spans],
  );

  // The "(omitted N spans)" row sits right after the root row: virtual index = row index + 1 past it.
  const omittedAfter =
    omitted !== undefined && omitted > 0 && rows.length > 0
      ? Math.max(
          0,
          rows.findIndex((r) => r.node.span.spanId === trace.rootSpanId),
        )
      : -1;
  const omittedAt = omittedAfter + 1;
  const toVirtual = (i: number) =>
    omittedAfter >= 0 && i > omittedAfter ? i + 1 : i;

  const virtualizer = useVirtualizer({
    count: rows.length + (omittedAfter >= 0 ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    // jsdom-free environments and the first paint have no layout yet; show a first screenful.
    initialRect: { width: 800, height: Math.min(MAX_HEIGHT, 20 * ROW_HEIGHT) },
  });

  const ticks = useMemo(() => scaleTicks(tree.totalMs), [tree.totalMs]);
  const selected = selectedId ? tree.byId.get(selectedId) : undefined;
  const viewport = Math.min(
    (rows.length + (omittedAfter >= 0 ? 1 : 0)) * ROW_HEIGHT + ROW_HEIGHT,
    MAX_HEIGHT,
  );

  const select = (id: string) => {
    setSelectedId(id);
    const index = rows.findIndex((r) => r.node.span.spanId === id);
    if (index >= 0) virtualizer.scrollToIndex(toVirtual(index));
  };

  /** Highlights the spans of one statement and shows the first of them; again clears it. */
  const pickQuery = (text: string) => {
    const query = queries.find((q) => q.text === text);
    if (!query || pickedQuery === text) {
      setPickedQuery(null);
      return;
    }
    setPickedQuery(text);
    const first = query.spanIds[0];
    if (first === undefined) return;
    // Open every collapsed ancestor so the span has a row.
    const open = new Set(collapsed);
    for (
      let parent = tree.byId.get(first)?.span.parentSpanId;
      parent !== undefined;
      parent = tree.byId.get(parent)?.span.parentSpanId
    )
      open.delete(parent);
    if (open.size !== collapsed.size) setCollapsed(open);
    setSelectedId(first);
    setDetailOpen(true);
    const index = flattenRows(tree, open).findIndex(
      (r) => r.node.span.spanId === first,
    );
    if (index >= 0) virtualizer.scrollToIndex(toVirtual(index));
  };

  /** Selects a span from outside the tree (a log line): opens its ancestors and shows it. */
  const showSpan = (id: string) => {
    if (!tree.byId.has(id)) return;
    const open = new Set(collapsed);
    for (
      let parent = tree.byId.get(id)?.span.parentSpanId;
      parent !== undefined;
      parent = tree.byId.get(parent)?.span.parentSpanId
    )
      open.delete(parent);
    if (open.size !== collapsed.size) setCollapsed(open);
    setSelectedId(id);
    setDetailOpen(true);
    const index = flattenRows(tree, open).findIndex(
      (r) => r.node.span.spanId === id,
    );
    if (index >= 0) virtualizer.scrollToIndex(toVirtual(index));
  };

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (NAV_KEYS.has(event.key)) {
      event.preventDefault();
      const result = navigate(rows, selectedId, collapsed, event.key as NavKey);
      if (result.collapsed !== collapsed) setCollapsed(result.collapsed);
      if (result.selectedId !== null && result.selectedId !== selectedId) {
        // The selection can only move to a row that is visible after the change.
        const visible =
          result.collapsed === collapsed
            ? rows
            : flattenRows(tree, result.collapsed);
        const index = visible.findIndex(
          (r) => r.node.span.spanId === result.selectedId,
        );
        setSelectedId(result.selectedId);
        if (index >= 0) virtualizer.scrollToIndex(toVirtual(index));
      }
    } else if (event.key === "Enter" && selectedId !== null) {
      event.preventDefault();
      setDetailOpen(true);
    } else if (event.key === "Escape" && detailOpen) {
      setDetailOpen(false);
    }
  };

  return (
    <div className="space-y-4">
      <TimeSummary
        breakdown={breakdown}
        criticalPathOn={criticalOn}
        onToggleCriticalPath={() => setCriticalOn((on) => !on)}
      />
      {queries.length > 0 ? (
        <QueriesPanel
          queries={queries}
          pickedText={pickedQuery}
          onPick={pickQuery}
        />
      ) : null}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Section
          flush
          testId="waterfall-card"
          title="Waterfall"
          description="Every span on a shared time axis; click a row for details, arrow keys to move"
          source="from this trace's spans"
          className="flex-1"
          actions={
            <ul
              data-testid="waterfall-legend"
              className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
            >
              {(
                [
                  ["code", "Code"],
                  ["database", "Database"],
                  ["cache", "Cache"],
                  ["http", "HTTP out"],
                  ["messaging", "Messaging"],
                ] as const
              ).map(([category, label]) => (
                <li key={category} className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className={cn("size-2 rounded-sm", CATEGORY_BG[category])}
                  />
                  {label}
                </li>
              ))}
              <li className="flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-sm bg-warning" />
                Slow query
              </li>
              <li className="flex items-center gap-1">
                <span
                  aria-hidden
                  className="size-2 rounded-sm bg-destructive"
                />
                Error
              </li>
            </ul>
          }
        >
          <div
            ref={scrollRef}
            role="treegrid"
            data-testid="waterfall"
            aria-label="Trace waterfall"
            aria-rowcount={rows.length}
            aria-activedescendant={
              selectedId ? rowDomId(selectedId) : undefined
            }
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="overflow-auto border-t border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            style={{ height: viewport }}
          >
            <div className="min-w-[640px]">
              <div
                role="row"
                data-testid="waterfall-scale"
                className="sticky top-0 z-10 flex h-7 border-b border-border bg-muted text-xs text-muted-foreground"
              >
                <div role="columnheader" className="w-72 shrink-0 px-2 py-1.5">
                  Span
                </div>
                <div role="columnheader" className="relative flex-1">
                  {ticks.map((tick, i) => (
                    <span
                      key={tick.leftPct}
                      data-testid="scale-tick"
                      className="absolute top-1.5 whitespace-nowrap tabular-nums"
                      style={{
                        left: `${tick.leftPct}%`,
                        transform:
                          i === ticks.length - 1
                            ? "translateX(-100%)"
                            : undefined,
                      }}
                    >
                      {formatDuration(tick.offsetMs)}
                    </span>
                  ))}
                </div>
              </div>
              <div
                className="relative"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  if (omittedAfter >= 0 && item.index === omittedAt) {
                    const parent = rows[omittedAfter] as Row;
                    return (
                      <div
                        key="omitted-spans"
                        role="row"
                        data-testid="omitted-row"
                        aria-rowindex={item.index + 1}
                        className="absolute inset-x-0 flex items-center border-b border-border/40 text-sm italic text-muted-foreground"
                        style={{ top: item.start, height: ROW_HEIGHT }}
                      >
                        <div
                          role="gridcell"
                          className="w-72 shrink-0 truncate px-2"
                          style={{
                            paddingLeft:
                              8 +
                              Math.min(parent.depth + 1, MAX_INDENT_LEVELS) *
                                INDENT_PX +
                              20,
                          }}
                        >
                          {omittedLabel(omitted as number)}
                        </div>
                        <div role="gridcell" className="flex-1" />
                      </div>
                    );
                  }
                  const rowIndex =
                    omittedAfter >= 0 && item.index > omittedAt
                      ? item.index - 1
                      : item.index;
                  const row = rows[rowIndex] as Row;
                  return (
                    <WaterfallRow
                      key={row.node.span.spanId}
                      row={row}
                      index={item.index}
                      top={item.start}
                      startMs={tree.startMs}
                      totalMs={tree.totalMs}
                      gridPcts={ticks.map((t) => t.leftPct)}
                      selected={row.node.span.spanId === selectedId}
                      highlighted={highlighted.has(row.node.span.spanId)}
                      critical={critical.has(row.node.span.spanId)}
                      logSummary={spanLogs.get(row.node.span.spanId)}
                      onSelect={() => {
                        select(row.node.span.spanId);
                        setDetailOpen(true);
                        scrollRef.current?.focus();
                      }}
                      onToggle={() => toggle(row.node.span.spanId)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </Section>
        {detailOpen && selected ? (
          <SpanDetail
            span={selected.span}
            traceStartMs={tree.startMs}
            orphan={selected.orphan}
            onClose={() => {
              setDetailOpen(false);
              scrollRef.current?.focus();
            }}
          />
        ) : null}
      </div>
      {logLines !== undefined && logLines.length > 0 ? (
        <LogsPanel
          logs={logLines}
          truncated={logs?.truncated ?? false}
          traceStartMs={tree.startMs}
          spanIds={spanIds}
          selectedSpanId={selectedId}
          onSelectSpan={showSpan}
        />
      ) : null}
    </div>
  );
}

function WaterfallRow({
  row,
  index,
  top,
  startMs,
  totalMs,
  gridPcts,
  selected,
  highlighted,
  critical,
  logSummary,
  onSelect,
  onToggle,
}: {
  row: Row;
  index: number;
  top: number;
  startMs: number;
  totalMs: number;
  /** Positions (percent) of the time axis ticks, drawn as faint lines in the bar cell. */
  gridPcts: number[];
  selected: boolean;
  highlighted: boolean;
  critical: boolean;
  logSummary?: SpanLogSummary | undefined;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { span } = row.node;
  const error = isErrorSpan(span);
  const slow = isSlowDbSpan(span);
  const { leftPct, widthPct } = barLayout(span, startMs, totalMs);
  const levels = Math.min(row.depth, MAX_INDENT_LEVELS);
  const indent = levels * INDENT_PX;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard control is on the treegrid (arrows, Enter)
    <div
      id={rowDomId(span.spanId)}
      role="row"
      data-testid="span-row"
      data-span-id={span.spanId}
      data-depth={row.depth}
      data-error={error ? "true" : undefined}
      data-slow={slow ? "true" : undefined}
      data-highlighted={highlighted ? "true" : undefined}
      data-critical={critical ? "true" : undefined}
      data-orphan={row.node.orphan ? "true" : undefined}
      aria-level={row.depth + 1}
      aria-rowindex={index + 1}
      aria-expanded={row.expanded ?? undefined}
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "absolute inset-x-0 flex cursor-pointer items-center border-b border-border/40 text-sm hover:bg-muted/60",
        error && "bg-destructive/5",
        highlighted && "bg-warning/15",
        critical && "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]",
        selected && "bg-muted",
      )}
      style={{ top, height: ROW_HEIGHT }}
    >
      <div
        role="gridcell"
        className="relative flex w-72 shrink-0 items-center gap-1 overflow-hidden px-2"
        style={{ paddingLeft: 8 + indent }}
      >
        {Array.from({ length: levels }, (_, level) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: guides are positional
            key={level}
            aria-hidden
            data-testid="nest-guide"
            className="absolute inset-y-0 w-px bg-border"
            style={{ left: 8 + level * INDENT_PX + 8 }}
          />
        ))}
        {row.expanded === null ? (
          <span className="size-4 shrink-0" />
        ) : (
          <button
            type="button"
            tabIndex={-1}
            aria-label={row.expanded ? "Collapse" : "Expand"}
            data-testid="span-toggle"
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            {row.expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        )}
        {error ? (
          <AlertCircle
            className="size-3.5 shrink-0 text-destructive"
            aria-label="Error"
            role="img"
          />
        ) : null}
        {row.node.orphan ? (
          <CornerUpRight
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label="Parent span is not in this trace"
            role="img"
            data-testid="orphan-marker"
          />
        ) : null}
        <span
          data-testid="span-name"
          className={cn("truncate", error && "text-destructive")}
          title={span.name}
        >
          {span.name}
        </span>
        <span
          data-testid="span-kind"
          className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {span.kind}
        </span>
        {logSummary ? (
          <span
            data-testid="log-marker"
            data-tone={logTone(logSummary.maxSeverity)}
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
              toneClass(logTone(logSummary.maxSeverity)) ||
                "text-muted-foreground",
            )}
            title={`${logSummary.count} log ${logSummary.count === 1 ? "line" : "lines"}`}
          >
            <ScrollText className="size-3" aria-hidden="true" />
            {logSummary.count}
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="relative h-full flex-1">
        {gridPcts.map((pct) => (
          <span
            key={pct}
            aria-hidden
            className="absolute inset-y-0 w-px bg-border/50"
            style={{ left: `${pct}%` }}
          />
        ))}
        <div
          data-testid="span-bar"
          data-left-pct={leftPct}
          data-width-pct={widthPct}
          className={cn(
            "absolute top-1/2 h-3.5 min-w-[2px] -translate-y-1/2 rounded-[3px]",
            error
              ? "bg-destructive"
              : slow
                ? "bg-warning"
                : CATEGORY_BG[categoryOf(span)],
          )}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        />
        {logSummary && logSummary.lines.length <= MAX_LOG_TICKS
          ? logSummary.lines.map((line, i) => {
              const tone = logTone(line.severity);
              const pct =
                totalMs > 0
                  ? Math.min(
                      100,
                      Math.max(
                        0,
                        ((line.timeUnixMs - startMs) / totalMs) * 100,
                      ),
                    )
                  : 0;
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: ticks have no id; the span's lines keep their order
                  key={i}
                  data-testid="log-tick"
                  data-tone={tone}
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute top-1 h-5 w-0.5 -translate-x-1/2 rounded-full",
                    tone === "error" || tone === "fatal"
                      ? "bg-destructive"
                      : tone === "warn"
                        ? "bg-warning"
                        : "bg-foreground/50",
                  )}
                  style={{ left: `${pct}%` }}
                />
              );
            })
          : null}
        <span
          data-testid="span-duration"
          className={cn(
            "absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground",
            // A bar that fills the row has no room beside it: the label goes inside, on a chip.
            leftPct + widthPct > 80 && leftPct < 15
              ? "rounded bg-background/85 px-1 text-foreground"
              : "px-1",
          )}
          style={
            leftPct + widthPct <= 80
              ? { left: `${leftPct + widthPct}%` }
              : leftPct < 15
                ? { right: `${100 - leftPct - widthPct}%`, marginRight: 4 }
                : { right: `${100 - leftPct}%` }
          }
        >
          {formatDuration(span.durationMs)}
        </span>
      </div>
    </div>
  );
}
