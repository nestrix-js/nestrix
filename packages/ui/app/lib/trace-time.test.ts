import type { SpanRecord } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  categoryOf,
  criticalPath,
  selfTimeMs,
  timeBreakdown,
} from "@/lib/trace-time";
import { buildTree } from "@/lib/trace-tree";

const span = (
  id: string,
  parent: string | undefined,
  start: number,
  durationMs: number,
  attributes: SpanRecord["attributes"] = {},
  kind: SpanRecord["kind"] = "internal",
): SpanRecord => ({
  spanId: id,
  parentSpanId: parent,
  name: `span ${id}`,
  kind,
  startTimeUnixMs: 1000 + start,
  durationMs,
  attributes,
  events: [],
  status: { code: "unset" },
  links: [],
});

const breakdownOf = (spans: SpanRecord[], root?: string) =>
  timeBreakdown(buildTree(spans, root));

describe("categoryOf", () => {
  it("classifies by attributes, redis before other databases", () => {
    const of = (
      attrs: SpanRecord["attributes"],
      kind: SpanRecord["kind"] = "internal",
    ) => categoryOf(span("a", undefined, 0, 1, attrs, kind));
    expect(of({ "db.system": "mysql" })).toBe("database");
    expect(of({ "db.system.name": "redis" })).toBe("cache");
    expect(of({ "messaging.system": "kafka" })).toBe("messaging");
    expect(of({ "http.request.method": "GET" }, "client")).toBe("http");
    expect(of({ "url.full": "https://x" }, "client")).toBe("http");
    // A server span with a method is the request itself, not outbound HTTP.
    expect(of({ "http.request.method": "GET" }, "server")).toBe("other");
    expect(of({ "nestrix.class": "Svc" })).toBe("code");
    expect(of({})).toBe("other");
  });
});

describe("selfTimeMs", () => {
  it("subtracts children, counts parallel children once and clips at 0", () => {
    const tree = buildTree([
      span("p", undefined, 0, 100),
      span("c1", "p", 10, 40),
      span("c2", "p", 30, 40), // overlaps c1: union is 10..70 = 60
      span("q", undefined, 0, 10),
      span("q1", "q", 0, 30), // longer than its parent
    ]);
    const self = (id: string) => selfTimeMs(tree.byId.get(id) as never);
    expect(self("p")).toBeCloseTo(40);
    expect(self("q")).toBe(0);
    expect(self("c1")).toBe(40);
  });
});

describe("timeBreakdown", () => {
  const spans = [
    span("r", undefined, 0, 100, {}, "server"),
    span("h", "r", 0, 90, { "nestrix.class": "OrdersService" }),
    span("d", "h", 10, 50, { "db.system.name": "postgresql" }),
    span("h2", "h", 60, 10, { "nestrix.class": "OrdersService" }),
  ];
  it("sums self time by category with percentages of the total", () => {
    const { totalMs, categories } = breakdownOf(spans, "r");
    // r: 10, h: 90 - 50 - 10 = 30, d: 50, h2: 10 -> 100
    expect(totalMs).toBeCloseTo(100);
    expect(categories.map((c) => [c.category, Math.round(c.pct)])).toEqual([
      ["database", 50],
      ["code", 40],
      ["other", 10],
    ]);
  });
  it("groups code spans by class in the top list and limits it to five", () => {
    const { top } = breakdownOf(spans, "r");
    expect(top[0]).toMatchObject({
      label: "span d",
      selfMs: 50,
      category: "database",
    });
    expect(top[1]).toMatchObject({
      label: "OrdersService",
      selfMs: 40,
      spanIds: ["h", "h2"],
    });
    const many = Array.from({ length: 8 }, (_, i) =>
      span(`s${i}`, undefined, 0, 10 + i),
    );
    expect(breakdownOf(many).top).toHaveLength(5);
  });
  it("handles an empty trace", () => {
    expect(breakdownOf([])).toEqual({ totalMs: 0, categories: [], top: [] });
  });
});

describe("criticalPath", () => {
  it("follows the child that ends last from the root", () => {
    const tree = buildTree(
      [
        span("r", undefined, 0, 100),
        span("a", "r", 0, 30),
        span("b", "r", 10, 85), // ends at 95: the last
        span("b1", "b", 20, 20),
        span("b2", "b", 30, 60), // ends at 90
      ],
      "r",
    );
    expect(criticalPath(tree, "r")).toEqual(["r", "b", "b2"]);
  });
  it("is the root alone for one span, and empty for none", () => {
    const one = buildTree([span("r", undefined, 0, 5)], "r");
    expect(criticalPath(one, "r")).toEqual(["r"]);
    expect(criticalPath(buildTree([]))).toEqual([]);
  });
});
