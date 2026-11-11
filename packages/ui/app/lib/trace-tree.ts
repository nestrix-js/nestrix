// Pure logic of the trace waterfall: the span tree, the visible rows, the time axis and the
// keyboard model. No React, so it is unit-tested directly.
import type { SpanRecord } from "@nestrix-js/protocol";

/** A span is an error when its status is `error` (docs/backlog/phase-2.md "Public API"). */
export const isErrorSpan = (span: SpanRecord): boolean =>
  span.status.code === "error";

export interface TreeNode {
  span: SpanRecord;
  /** Children by start time. */
  children: TreeNode[];
  /** The span names a parent that is not in the trace (and is not the trace's local root). */
  orphan: boolean;
}

export interface TraceTree {
  /** Top-level nodes by start time: spans without a parent, and orphans. */
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
  /** Earliest span start, Unix ms. */
  startMs: number;
  /** Time axis length: latest span end minus `startMs`; never 0. */
  totalMs: number;
}

const byStart = (a: TreeNode, b: TreeNode) =>
  a.span.startTimeUnixMs - b.span.startTimeUnixMs ||
  (a.span.spanId < b.span.spanId ? -1 : a.span.spanId > b.span.spanId ? 1 : 0);

/**
 * Builds the tree from `parentSpanId`. A span whose parent is missing becomes a root (marked
 * `orphan`, except the trace's own local root, whose remote parent is expected). A repeated
 * span id keeps the first span, and a parent cycle is broken by promoting its earliest span
 * to a root, so every span is shown exactly once.
 */
export function buildTree(
  spans: readonly SpanRecord[],
  rootSpanId?: string,
): TraceTree {
  const byId = new Map<string, TreeNode>();
  for (const span of spans)
    if (!byId.has(span.spanId))
      byId.set(span.spanId, { span, children: [], orphan: false });

  const nodes = [...byId.values()].sort(byStart);
  const roots: TreeNode[] = [];
  for (const node of nodes) {
    const parentId = node.span.parentSpanId;
    const parent =
      parentId !== undefined && parentId !== node.span.spanId
        ? byId.get(parentId)
        : undefined;
    if (parent) parent.children.push(node);
    else {
      node.orphan = parentId !== undefined && node.span.spanId !== rootSpanId;
      roots.push(node);
    }
  }

  // Nodes not reachable from a root sit on a parent cycle.
  const seen = new Set<TreeNode>();
  const mark = (start: TreeNode) => {
    const stack = [start];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const child of node.children) stack.push(child);
    }
  };
  for (const root of roots) mark(root);
  for (const node of nodes) {
    if (seen.has(node)) continue;
    const parent = byId.get(node.span.parentSpanId as string);
    if (parent) parent.children = parent.children.filter((c) => c !== node);
    node.orphan = true;
    roots.push(node);
    mark(node);
  }
  roots.sort(byStart);

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const { span } of nodes) {
    startMs = Math.min(startMs, span.startTimeUnixMs);
    endMs = Math.max(endMs, span.startTimeUnixMs + span.durationMs);
  }
  if (nodes.length === 0) {
    startMs = 0;
    endMs = 0;
  }
  return { roots, byId, startMs, totalMs: Math.max(endMs - startMs, 1e-6) };
}

export interface Row {
  node: TreeNode;
  depth: number;
  parentId: string | null;
  /** `null` for a span without children. */
  expanded: boolean | null;
}

/** The rows in display order (pre-order), omitting the descendants of collapsed spans. */
export function flattenRows(
  tree: TraceTree,
  collapsed: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = [];
  type Frame = { node: TreeNode; depth: number; parentId: string | null };
  const stack: Frame[] = [];
  for (let i = tree.roots.length - 1; i >= 0; i--)
    stack.push({ node: tree.roots[i] as TreeNode, depth: 0, parentId: null });
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const { node, depth, parentId } = frame;
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren ? !collapsed.has(node.span.spanId) : null;
    rows.push({ node, depth, parentId, expanded });
    if (expanded)
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push({
          node: node.children[i] as TreeNode,
          depth: depth + 1,
          parentId: node.span.spanId,
        });
  }
  return rows;
}

/** Position of a span's bar on the trace axis, in percent of its width. */
export function barLayout(
  span: Pick<SpanRecord, "startTimeUnixMs" | "durationMs">,
  startMs: number,
  totalMs: number,
): { leftPct: number; widthPct: number } {
  const left = ((span.startTimeUnixMs - startMs) / totalMs) * 100;
  const leftPct = Math.min(Math.max(left, 0), 100);
  const widthPct = Math.min(
    Math.max((span.durationMs / totalMs) * 100, 0),
    100 - leftPct,
  );
  return { leftPct, widthPct };
}

/** `count` + 1 evenly spaced marks from 0 to the end of the axis, for the scale header. */
export function scaleTicks(
  totalMs: number,
  count = 4,
): { offsetMs: number; leftPct: number }[] {
  return Array.from({ length: count + 1 }, (_, i) => ({
    offsetMs: (totalMs * i) / count,
    leftPct: (100 * i) / count,
  }));
}

export type NavKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End";

/**
 * Keyboard model over the visible rows. Up and down move the selection; left collapses the
 * selected span, or moves to its parent when it is a leaf or already collapsed; right expands
 * it, or moves to its first child when it is already expanded.
 */
export function navigate(
  rows: readonly Row[],
  selectedId: string | null,
  collapsed: ReadonlySet<string>,
  key: NavKey,
): { selectedId: string | null; collapsed: ReadonlySet<string> } {
  if (rows.length === 0) return { selectedId, collapsed };
  const index = rows.findIndex((r) => r.node.span.spanId === selectedId);
  const idAt = (i: number) =>
    (rows[Math.min(Math.max(i, 0), rows.length - 1)] as Row).node.span.spanId;
  const current = index >= 0 ? (rows[index] as Row) : undefined;
  const withSet = (mutate: (set: Set<string>) => void) => {
    const next = new Set(collapsed);
    mutate(next);
    return next;
  };

  switch (key) {
    case "Home":
      return { selectedId: idAt(0), collapsed };
    case "End":
      return { selectedId: idAt(rows.length - 1), collapsed };
    case "ArrowDown":
      return { selectedId: idAt(index + 1), collapsed };
    case "ArrowUp":
      return { selectedId: idAt(index < 0 ? 0 : index - 1), collapsed };
    case "ArrowLeft": {
      if (!current) return { selectedId: idAt(0), collapsed };
      if (current.expanded === true)
        return {
          selectedId,
          collapsed: withSet((s) => s.add(current.node.span.spanId)),
        };
      return { selectedId: current.parentId ?? selectedId, collapsed };
    }
    case "ArrowRight": {
      if (!current) return { selectedId: idAt(0), collapsed };
      if (current.expanded === false)
        return {
          selectedId,
          collapsed: withSet((s) => s.delete(current.node.span.spanId)),
        };
      if (current.expanded === true)
        return { selectedId: idAt(index + 1), collapsed };
      return { selectedId, collapsed };
    }
  }
}
