import type { ClassKind, ClassStats } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  formatShare,
  kindBreakdown,
  kindGroup,
  summarizeClasses,
} from "@/views/classes/class-kpis";

const cls = (
  className: string,
  kind: ClassKind,
  calls: number,
  errors: number,
  totalMs: number,
  ownMs: number | null,
): ClassStats => ({
  className,
  kind,
  calls,
  errors,
  totalMs,
  avgMs: calls ? totalMs / calls : 0,
  ownMs,
  methods: [],
});

const CLASSES = [
  cls("OrdersController", "controller", 50, 3, 1280, 130),
  cls("OrdersService", "service", 55, 3, 1065, 400),
  cls("AuthGuard", "guard", 50, 0, 25, null),
  cls("LoggingInterceptor", "interceptor", 10, 0, 10, 10),
];

describe("kindGroup", () => {
  it("puts guards, pipes, interceptors and filters in one group and keeps the others", () => {
    expect(kindGroup("guard")).toBe("pipeline");
    expect(kindGroup("pipe")).toBe("pipeline");
    expect(kindGroup("interceptor")).toBe("pipeline");
    expect(kindGroup("filter")).toBe("pipeline");
    expect(kindGroup("controller")).toBe("controller");
    expect(kindGroup("processor")).toBe("processor");
    expect(kindGroup("provider")).toBe("other");
  });
});

describe("kindBreakdown", () => {
  it("sums own time per group when estimates exist, leaving empty groups out", () => {
    const { basis, shares, sum } = kindBreakdown(CLASSES);
    expect(basis).toBe("own");
    expect(shares.map((s) => [s.key, s.value])).toEqual([
      ["controller", 130],
      ["service", 400],
      ["pipeline", 10],
    ]);
    expect(sum).toBe(540);
  });
  it("falls back to total time when no class has an own-time estimate", () => {
    const { basis, shares } = kindBreakdown([
      cls("A", "service", 1, 0, 40, null),
      cls("B", "provider", 1, 0, 10, null),
    ]);
    expect(basis).toBe("total");
    expect(shares.map((s) => [s.key, s.value])).toEqual([
      ["service", 40],
      ["other", 10],
    ]);
  });
  it("is empty without classes", () => {
    expect(kindBreakdown([])).toEqual({ basis: "total", shares: [], sum: 0 });
  });
});

describe("summarizeClasses", () => {
  it("adds up calls, errors and time and finds the class with the most own time", () => {
    const s = summarizeClasses(CLASSES);
    expect(s.classes).toBe(4);
    expect(s.calls).toBe(165);
    expect(s.errors).toBe(6);
    expect(s.errorRate).toBeCloseTo(6 / 165);
    expect(s.totalMs).toBe(2380);
    expect(s.ownMs).toBe(540);
    expect(s.heaviest?.className).toBe("OrdersService");
  });
  it("has no own time or rate when nothing is estimated or called", () => {
    const s = summarizeClasses([cls("A", "service", 0, 0, 0, null)]);
    expect(s.ownMs).toBeNull();
    expect(s.errorRate).toBeNull();
    expect(summarizeClasses([]).heaviest).toBeNull();
  });
  it("ranks by total time when no class has an estimate", () => {
    const s = summarizeClasses([
      cls("A", "service", 1, 0, 5, null),
      cls("B", "service", 1, 0, 50, null),
    ]);
    expect(s.heaviest?.className).toBe("B");
  });
});

describe("formatShare", () => {
  it("rounds, marks slivers and has no share without a total", () => {
    expect(formatShare(1, 3)).toBe("33%");
    expect(formatShare(1, 1000)).toBe("<1%");
    expect(formatShare(0, 10)).toBe("0%");
    expect(formatShare(1, 0)).toBe("-");
  });
});
