import type { ClassStats, MethodStats } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  formatOwn,
  methodOwnMs,
  sortClasses,
  sortMethods,
} from "@/views/classes/class-stats";

const cls = (over: Partial<ClassStats>): ClassStats => ({
  className: "X",
  kind: "service",
  calls: 1,
  errors: 0,
  totalMs: 1,
  avgMs: 1,
  ownMs: null,
  methods: [],
  ...over,
});
const meth = (over: Partial<MethodStats>): MethodStats => ({
  method: "m",
  calls: 1,
  errors: 0,
  totalMs: 1,
  avgMs: 1,
  maxMs: 1,
  ownAvgMs: null,
  ...over,
});
const names = (c: ClassStats[]) => c.map((x) => x.className);

describe("sortClasses", () => {
  const input = [
    cls({ className: "B", totalMs: 10, calls: 5, ownMs: null, kind: "guard" }),
    cls({ className: "A", totalMs: 10, calls: 9, ownMs: 3, kind: "service" }),
    cls({
      className: "C",
      totalMs: 99,
      calls: 1,
      ownMs: 8,
      kind: "controller",
    }),
  ];

  it("sorts numbers both ways, ties by name ascending, input untouched", () => {
    expect(names(sortClasses(input, "total", "desc"))).toEqual(["C", "A", "B"]);
    expect(names(sortClasses(input, "total", "asc"))).toEqual(["A", "B", "C"]);
    expect(names(sortClasses(input, "calls", "desc"))).toEqual(["A", "B", "C"]);
    expect(names(input)).toEqual(["B", "A", "C"]);
  });

  it("sorts text columns", () => {
    expect(names(sortClasses(input, "name", "desc"))).toEqual(["C", "B", "A"]);
    expect(names(sortClasses(input, "kind", "asc"))).toEqual(["C", "B", "A"]);
  });

  it("puts a missing own time below every number", () => {
    expect(names(sortClasses(input, "own", "desc"))).toEqual(["C", "A", "B"]);
    expect(names(sortClasses(input, "own", "asc"))).toEqual(["B", "A", "C"]);
  });
});

describe("methods", () => {
  it("own time is the per-call estimate times calls", () => {
    expect(methodOwnMs(meth({ ownAvgMs: 2, calls: 10 }))).toBe(20);
    expect(methodOwnMs(meth({ ownAvgMs: null, calls: 10 }))).toBeNull();
  });

  it("sorts by the derived own time", () => {
    const ms = [
      meth({ method: "a", ownAvgMs: 1, calls: 5 }),
      meth({ method: "b", ownAvgMs: 0.5, calls: 100 }),
      meth({ method: "c", ownAvgMs: null }),
    ];
    expect(sortMethods(ms, "own", "desc").map((m) => m.method)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

describe("formatOwn", () => {
  it("shows a dash without an estimate", () => {
    expect(formatOwn(null, String)).toBe("-");
    expect(formatOwn(4, (v) => `${v} ms`)).toBe("4 ms");
  });
});
