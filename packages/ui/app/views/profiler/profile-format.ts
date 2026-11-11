import type { FlameNode } from "@nestrix/protocol";

/** Where a frame's code lives; the flame graph's colour (three hues, see styles.css). */
export type FrameKind = "app" | "deps" | "runtime";

export const frameKindLabel: Record<FrameKind, string> = {
  app: "Application",
  deps: "Dependencies (node_modules)",
  runtime: "Node.js and V8",
};

/** `file://` outside `node_modules` is the app; inside is a dependency; `node:` and V8's own are runtime. */
export function frameKind(url: string): FrameKind {
  if (!url.startsWith("file:")) return "runtime";
  return /[\\/]node_modules[\\/]/.test(url) ? "deps" : "app";
}

/** The last two path segments of a URL, enough to tell files apart; empty for V8's entries. */
export function shortUrl(url: string): string {
  if (url === "") return "";
  const path = url.replace(/^file:\/\//, "");
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

/** `name file:line`, as the table and the flame graph's tooltip print a frame. */
export function frameLabel(f: {
  functionName: string;
  url: string;
  line: number;
}): string {
  const where = shortUrl(f.url);
  return where ? `${f.functionName} ${where}:${f.line}` : f.functionName;
}

/** One bar of the flame graph: `x` and `width` are fractions of the focused node's width. */
export interface FlameBar {
  /** Child indexes from the root, `"0.2.1"`; the root is `""`. Stable across renders. */
  path: string;
  depth: number;
  x: number;
  width: number;
  node: FlameNode;
  kind: FrameKind;
}

/** Bars narrower than this share of the focus are not drawn (they would be sub-pixel). */
export const MIN_BAR_WIDTH = 0.001;

/** The node at `path` (child indexes joined by `.`), or `undefined`. */
export function nodeAt(root: FlameNode, path: string): FlameNode | undefined {
  if (path === "") return root;
  let node: FlameNode | undefined = root;
  for (const part of path.split(".")) {
    node = node?.children[Number(part)];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Lays out the subtree at `focusPath` top-down (the focus is the first row, full width; each
 * child sits under its parent, left to right, as wide as its share of the focus's samples).
 * Pure; iterative, so a deep tree cannot overflow the stack.
 */
export function layoutFlame(
  root: FlameNode,
  focusPath = "",
): { bars: FlameBar[]; depth: number } {
  const focus = nodeAt(root, focusPath) ?? root;
  const start = nodeAt(root, focusPath) ? focusPath : "";
  const total = focus.totalSamples;
  const bars: FlameBar[] = [];
  if (total <= 0) return { bars, depth: 0 };
  let depth = 0;
  const stack: { node: FlameNode; path: string; depth: number; x: number }[] = [
    { node: focus, path: start, depth: 0, x: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop() as (typeof stack)[number];
    const width = Math.min(1, item.node.totalSamples / total);
    if (width < MIN_BAR_WIDTH) continue;
    bars.push({
      path: item.path,
      depth: item.depth,
      x: item.x,
      width,
      node: item.node,
      kind: frameKind(item.node.url),
    });
    depth = Math.max(depth, item.depth + 1);
    let x = item.x;
    item.node.children.forEach((child, i) => {
      stack.push({
        node: child,
        path: item.path === "" ? String(i) : `${item.path}.${i}`,
        depth: item.depth + 1,
        x,
      });
      x += child.totalSamples / total;
    });
  }
  bars.sort((a, b) => a.depth - b.depth || a.x - b.x);
  return { bars, depth };
}

/** `0.4 ms`, `38 ms`, `1.2 s`. */
export function formatMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** `950 B`, `117 KB`, `1.2 MB` (decimal units, as npm and browsers print sizes). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Share of `part` in `whole` as `42.0%`. */
export function formatShare(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "-";
}

/**
 * The warning shown before starting: the measured pause of the latest capture in this process
 * when there is one, otherwise what the spike measured (P7-S1).
 */
export function startPauseWarning(lastStartPauseMs: number | null): string {
  if (lastStartPauseMs !== null) {
    return `Starting a capture pauses the application while V8 records the code it has compiled. The last capture here paused it for ${formatMs(lastStartPauseMs)}; expect about the same, more if more code has loaded since.`;
  }
  return "Starting a capture pauses the application while V8 records the code it has compiled: about 10 ms per MB of compiled code, typically 40 to 50 ms in a small Nest app and a few hundred milliseconds in a large one. Requests arriving meanwhile wait.";
}

/** Capture lengths offered, seconds. The server accepts 1 to 120. */
export const DURATION_OPTIONS = [10, 30, 60, 120] as const;
