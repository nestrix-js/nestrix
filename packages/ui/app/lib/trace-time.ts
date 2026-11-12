// Pure logic of the trace diagnosis: where the time went (self time by category and class) and
// the critical path. No React.
import type { SpanRecord } from "@nestrix-js/protocol";

import { isDbSpan } from "@/lib/trace-insights";
import type { TraceTree, TreeNode } from "@/lib/trace-tree";

export type TimeCategory =
  | "database"
  | "cache"
  | "http"
  | "messaging"
  | "code"
  | "other";

/** Display order of the categories in the bar and the legend. */
export const CATEGORIES: readonly TimeCategory[] = [
  "database",
  "cache",
  "http",
  "messaging",
  "code",
  "other",
];

export const CATEGORY_LABELS: Record<TimeCategory, string> = {
  database: "Database",
  cache: "Cache",
  http: "Outbound HTTP",
  messaging: "Messaging",
  code: "Your code",
  other: "Other",
};

const dbSystem = (span: SpanRecord): unknown =>
  span.attributes["db.system.name"] ?? span.attributes["db.system"];

/** The class a Nest method span belongs to (`nestrix.class`), if any. */
export const spanClass = (span: SpanRecord): string | undefined => {
  const value = span.attributes["nestrix.class"];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * What a span's own time is spent on. Redis is a cache, any other database system is the
 * database; then messaging, then outbound HTTP (a client span with an HTTP method or URL),
 * then Nest code (`nestrix.class`); everything else is other.
 */
export function categoryOf(span: SpanRecord): TimeCategory {
  if (isDbSpan(span)) return dbSystem(span) === "redis" ? "cache" : "database";
  if (span.attributes["messaging.system"] !== undefined) return "messaging";
  if (
    span.kind === "client" &&
    (span.attributes["http.request.method"] !== undefined ||
      span.attributes["url.full"] !== undefined)
  )
    return "http";
  if (spanClass(span) !== undefined) return "code";
  return "other";
}

/**
 * A span's own time: its duration minus the time covered by its children (the union of their
 * intervals clipped to the span, so parallel children are not subtracted twice), never below 0.
 */
export function selfTimeMs(node: TreeNode): number {
  const { span } = node;
  const start = span.startTimeUnixMs;
  const end = start + span.durationMs;
  const intervals = node.children
    .map((c) => {
      const s = Math.max(c.span.startTimeUnixMs, start);
      const e = Math.min(c.span.startTimeUnixMs + c.span.durationMs, end);
      return [s, e] as const;
    })
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [s, e] of intervals) {
    if (Number.isNaN(curEnd) || s > curEnd) {
      if (!Number.isNaN(curEnd)) covered += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (!Number.isNaN(curEnd)) covered += curEnd - curStart;
  return Math.max(span.durationMs - covered, 0);
}

export interface CategoryTime {
  category: TimeCategory;
  selfMs: number;
  /** Share of the trace's total self time, 0 to 100. */
  pct: number;
}

export interface TopItem {
  /** A class (all its spans together) or a single span. */
  key: string;
  label: string;
  category: TimeCategory;
  selfMs: number;
  pct: number;
  /** Span ids behind the item. */
  spanIds: string[];
}

export interface TimeBreakdown {
  totalMs: number;
  categories: CategoryTime[];
  top: TopItem[];
}

/**
 * Self time over the whole trace, by category (only those with time, in `CATEGORIES` order),
 * and the `topN` classes or spans with the most self time. Spans with `nestrix.class` are
 * grouped by class; any other span stands alone.
 */
export function timeBreakdown(tree: TraceTree, topN = 5): TimeBreakdown {
  const perCategory = new Map<TimeCategory, number>();
  const items = new Map<string, TopItem>();
  let totalMs = 0;
  for (const node of tree.byId.values()) {
    const self = selfTimeMs(node);
    if (self <= 0) continue;
    const { span } = node;
    const category = categoryOf(span);
    totalMs += self;
    perCategory.set(category, (perCategory.get(category) ?? 0) + self);
    const cls = category === "code" ? spanClass(span) : undefined;
    const key = cls !== undefined ? `class:${cls}` : `span:${span.spanId}`;
    const item = items.get(key) ?? {
      key,
      label: cls ?? span.name,
      category,
      selfMs: 0,
      pct: 0,
      spanIds: [],
    };
    item.selfMs += self;
    item.spanIds.push(span.spanId);
    items.set(key, item);
  }
  const pct = (ms: number) => (totalMs > 0 ? (ms / totalMs) * 100 : 0);
  const categories = CATEGORIES.flatMap((category) => {
    const selfMs = perCategory.get(category);
    return selfMs === undefined ? [] : [{ category, selfMs, pct: pct(selfMs) }];
  });
  const top = [...items.values()]
    .map((i) => ({ ...i, pct: pct(i.selfMs) }))
    .sort(
      (a, b) =>
        b.selfMs - a.selfMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, topN);
  return { totalMs, categories, top };
}

/**
 * The spans that determine the trace's end time: from the root, repeatedly the child that ends
 * last (ties: the one that started later, then the first). Ids from the root down.
 */
export function criticalPath(tree: TraceTree, rootSpanId?: string): string[] {
  const endOf = (n: TreeNode) => n.span.startTimeUnixMs + n.span.durationMs;
  const start =
    (rootSpanId !== undefined ? tree.byId.get(rootSpanId) : undefined) ??
    tree.roots.reduce<TreeNode | undefined>(
      (best, n) => (best === undefined || endOf(n) > endOf(best) ? n : best),
      undefined,
    );
  const path: string[] = [];
  for (let node = start; node; ) {
    path.push(node.span.spanId);
    let next: TreeNode | undefined;
    for (const child of node.children) {
      if (
        next === undefined ||
        endOf(child) > endOf(next) ||
        (endOf(child) === endOf(next) &&
          child.span.startTimeUnixMs > next.span.startTimeUnixMs)
      )
        next = child;
    }
    node = next;
  }
  return path;
}
