import type { SpanRecord, TraceResponse } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  barLayout,
  buildTree,
  flattenRows,
  navigate,
  scaleTicks,
} from "@/lib/trace-tree";

// The protocol fixture is not part of the package's exports and lies outside this project's
// TypeScript root, so it is loaded by path at run time.
const fixtureUrl = new URL(
  "../../../protocol/fixtures/trace.ts",
  import.meta.url,
).href;
const { trace } = (await import(/* @vite-ignore */ fixtureUrl)) as {
  trace: TraceResponse;
};
const generatorUrl = new URL("../../e2e/trace-generate.ts", import.meta.url)
  .href;
const { generateTrace } = (await import(/* @vite-ignore */ generatorUrl)) as {
  generateTrace: (count: number, fanOut?: number) => TraceResponse;
};

const span = (
  spanId: string,
  parentSpanId: string | undefined,
  start: number,
  durationMs = 1,
): SpanRecord => ({
  spanId,
  parentSpanId,
  name: spanId,
  kind: "internal",
  startTimeUnixMs: start,
  durationMs,
  attributes: {},
  events: [],
  status: { code: "unset" },
  links: [],
});

const names = (rows: ReturnType<typeof flattenRows>) =>
  rows.map((r) => r.node.span.name);

describe("tree from the protocol fixture", () => {
  const tree = buildTree(trace.spans, trace.rootSpanId);
  const rows = flattenRows(tree, new Set());

  it("orders rows depth-first, children by start time, with their depth", () => {
    expect(rows.map((r) => [r.node.span.name, r.depth])).toEqual([
      ["GET /orders/:id", 0],
      ["guard AuthGuard", 1],
      ["OrdersController.getOrder", 1],
      ["GET", 2],
    ]);
  });

  it("does not mark the local root, whose remote parent is expected", () => {
    expect(rows.some((r) => r.node.orphan)).toBe(false);
  });

  it("collapsing a span hides its descendants and reports it as collapsed", () => {
    const handler = trace.spans[2]?.spanId as string;
    const collapsed = flattenRows(tree, new Set([handler]));
    expect(names(collapsed)).toEqual([
      "GET /orders/:id",
      "guard AuthGuard",
      "OrdersController.getOrder",
    ]);
    expect(collapsed[2]?.expanded).toBe(false);
    expect(collapsed[1]?.expanded).toBeNull();
    const root = trace.spans[0]?.spanId as string;
    expect(names(flattenRows(tree, new Set([root])))).toEqual([
      "GET /orders/:id",
    ]);
  });
});

describe("tree edge cases", () => {
  it("orders siblings by start time, not input order", () => {
    const tree = buildTree([
      span("r", undefined, 0),
      span("late", "r", 9),
      span("early", "r", 2),
    ]);
    expect(names(flattenRows(tree, new Set()))).toEqual(["r", "early", "late"]);
  });

  it("shows a span with a missing parent at the root with a marker", () => {
    const tree = buildTree(
      [span("r", undefined, 0), span("lost", "gone", 5), span("c", "lost", 6)],
      "r",
    );
    const rows = flattenRows(tree, new Set());
    expect(rows.map((r) => [r.node.span.name, r.depth, r.node.orphan])).toEqual(
      [
        ["r", 0, false],
        ["lost", 0, true],
        ["c", 1, false],
      ],
    );
  });

  it("shows every span once when ids repeat or parents form a cycle", () => {
    const tree = buildTree([
      span("a", "b", 1),
      span("b", "a", 2),
      span("a", undefined, 3),
      span("s", "s", 4),
    ]);
    const rows = flattenRows(tree, new Set());
    expect(rows.map((r) => r.node.span.spanId).sort()).toEqual(["a", "b", "s"]);
  });

  it("handles an empty trace", () => {
    const tree = buildTree([]);
    expect(flattenRows(tree, new Set())).toEqual([]);
    expect(tree.totalMs).toBeGreaterThan(0);
  });
});

describe("time axis", () => {
  const tree = buildTree(trace.spans, trace.rootSpanId);

  it("spans from the earliest start to the latest end", () => {
    expect(tree.startMs).toBe(trace.spans[0]?.startTimeUnixMs);
    expect(tree.totalMs).toBeCloseTo(182.4, 3);
  });

  it("positions bars proportionally to start offset and duration", () => {
    for (const s of trace.spans) {
      const { leftPct, widthPct } = barLayout(s, tree.startMs, tree.totalMs);
      expect(leftPct).toBeCloseTo(
        ((s.startTimeUnixMs - tree.startMs) / 182.4) * 100,
        3,
      );
      expect(widthPct).toBeCloseTo((s.durationMs / 182.4) * 100, 3);
    }
    const client = trace.spans[3] as SpanRecord;
    const { leftPct, widthPct } = barLayout(client, tree.startMs, tree.totalMs);
    // 19.75 ms in, 150.6 ms long, on a 182.4 ms axis.
    expect(leftPct).toBeCloseTo(10.83, 2);
    expect(widthPct).toBeCloseTo(82.57, 2);
  });

  it("keeps a bar inside the axis", () => {
    expect(barLayout({ startTimeUnixMs: 95, durationMs: 50 }, 0, 100)).toEqual({
      leftPct: 95,
      widthPct: 5,
    });
  });

  it("puts scale ticks evenly from 0 to the full length", () => {
    const ticks = scaleTicks(200, 4);
    expect(ticks.map((t) => t.offsetMs)).toEqual([0, 50, 100, 150, 200]);
    expect(ticks.map((t) => t.leftPct)).toEqual([0, 25, 50, 75, 100]);
  });
});

describe("keyboard model", () => {
  const tree = buildTree(trace.spans, trace.rootSpanId);
  const [root, guard, handler, client] = trace.spans.map(
    (s) => s.spanId,
  ) as string[];
  const none = new Set<string>();

  it("moves the selection with up and down and stops at the ends", () => {
    const rows = flattenRows(tree, none);
    expect(navigate(rows, root as string, none, "ArrowDown").selectedId).toBe(
      guard,
    );
    expect(navigate(rows, client as string, none, "ArrowDown").selectedId).toBe(
      client,
    );
    expect(navigate(rows, root as string, none, "ArrowUp").selectedId).toBe(
      root,
    );
    expect(navigate(rows, guard as string, none, "ArrowUp").selectedId).toBe(
      root,
    );
    expect(navigate(rows, null, none, "ArrowDown").selectedId).toBe(root);
    expect(navigate(rows, guard as string, none, "End").selectedId).toBe(
      client,
    );
    expect(navigate(rows, client as string, none, "Home").selectedId).toBe(
      root,
    );
  });

  it("collapses with left, then moves to the parent", () => {
    const rows = flattenRows(tree, none);
    const first = navigate(rows, handler as string, none, "ArrowLeft");
    expect(first.selectedId).toBe(handler);
    expect(first.collapsed.has(handler as string)).toBe(true);
    const second = navigate(
      flattenRows(tree, first.collapsed),
      handler as string,
      first.collapsed,
      "ArrowLeft",
    );
    expect(second.selectedId).toBe(root);
    // A leaf goes to its parent at once.
    expect(navigate(rows, client as string, none, "ArrowLeft").selectedId).toBe(
      handler,
    );
  });

  it("expands with right, then moves to the first child", () => {
    const collapsed = new Set([handler as string]);
    const rows = flattenRows(tree, collapsed);
    const first = navigate(rows, handler as string, collapsed, "ArrowRight");
    expect(first.collapsed.has(handler as string)).toBe(false);
    expect(first.selectedId).toBe(handler);
    const second = navigate(
      flattenRows(tree, first.collapsed),
      handler as string,
      first.collapsed,
      "ArrowRight",
    );
    expect(second.selectedId).toBe(client);
    // A leaf stays where it is.
    expect(
      navigate(flattenRows(tree, none), client as string, none, "ArrowRight")
        .selectedId,
    ).toBe(client);
  });
});

describe("a generated 5,000-span trace", () => {
  const big = generateTrace(5000);
  const tree = buildTree(big.spans, big.rootSpanId);

  it("builds every row, each span once", () => {
    const rows = flattenRows(tree, new Set());
    expect(rows).toHaveLength(5000);
    expect(new Set(rows.map((r) => r.node.span.spanId)).size).toBe(5000);
    expect(rows[0]?.node.span.name).toBe("root");
    expect(Math.max(...rows.map((r) => r.depth))).toBe(6);
  });

  it("is fast enough to rebuild on every collapse", () => {
    const started = performance.now();
    const rows = flattenRows(buildTree(big.spans, big.rootSpanId), new Set());
    expect(rows).toHaveLength(5000);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("survives a chain 5,000 levels deep", () => {
    const chain = Array.from({ length: 5000 }, (_, i) =>
      span(`s${i}`, i === 0 ? undefined : `s${i - 1}`, i),
    );
    const rows = flattenRows(buildTree(chain), new Set());
    expect(rows).toHaveLength(5000);
    expect(rows.at(-1)?.depth).toBe(4999);
  });
});
