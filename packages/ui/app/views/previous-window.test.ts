import type {
  AppMapResponse,
  ClassStats,
  ClassStatsResponse,
  DependenciesResponse,
  DependencyStats,
  MapEdge,
} from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import { classChanges, rowAvgChange } from "@/views/classes/class-changes";
import { summarizeClasses } from "@/views/classes/class-kpis";
import {
  dependencyChanges,
  rowP95Change,
} from "@/views/dependencies/dependency-changes";
import { edgeP95Change, mapChanges } from "@/views/map/map-changes";
import {
  countChange,
  msChange,
  rateChange,
  whyNoPrevious,
} from "@/views/previous-window";

describe("whyNoPrevious", () => {
  it("says why, for each way an answer has none", () => {
    expect(whyNoPrevious(undefined)).toMatch(/not loaded/);
    expect(whyNoPrevious({})).toMatch(/does not send/);
    expect(whyNoPrevious({ previousCovered: false, note: "too young" })).toBe(
      "too young",
    );
    expect(whyNoPrevious({ previousCovered: false })).toMatch(/do not cover/);
    expect(whyNoPrevious({ previousCovered: true, note: null })).toBeNull();
  });
});

describe("change helpers", () => {
  it("counts as a neutral percentage, and are unknown without a base", () => {
    expect(countChange(100, 150, "calls")).toMatchObject({
      text: "+50%",
      tone: "neutral",
    });
    expect(countChange(0, 5, "calls").text).toBe("—");
    expect(countChange(undefined, 5, "calls").text).toBe("—");
  });

  it("error rate and durations are worse when they rise", () => {
    expect(rateChange(0.01, 0.03)).toMatchObject({
      text: "+2.0 pt",
      tone: "worse",
    });
    expect(rateChange(0.05, 0.01).tone).toBe("better");
    expect(rateChange(null, 0.01).text).toBe("—");
    expect(msChange(100, 150)).toMatchObject({ tone: "worse" });
    expect(msChange(150, 100)).toMatchObject({ tone: "better" });
    expect(msChange(0, 100).text).toBe("—");
    expect(msChange(null, 100).text).toBe("—");
  });
});

const dep = (
  id: string,
  over: Partial<DependencyStats> = {},
): DependencyStats => ({
  id,
  kind: "database",
  name: id,
  calls: 10,
  errors: 1,
  errorRate: 0.1,
  totalMs: 100,
  p50Ms: 5,
  p95Ms: 50,
  series: [],
  ...over,
});
const depsAnswer = (
  dependencies: DependencyStats[],
  over: Partial<DependenciesResponse> = {},
): DependenciesResponse => ({
  windowMinutes: 15,
  fromUnixMs: 0,
  toUnixMs: 1,
  bucketMs: 60_000,
  dependencies,
  ...over,
});

describe("dependencyChanges", () => {
  const prev = (calls: number, errors: number, p95Ms: number) => ({
    calls,
    errors,
    errorRate: calls ? errors / calls : 0,
    totalMs: 0,
    p50Ms: 0,
    p95Ms,
  });

  it("uses the answer's totals, which include targets that are gone", () => {
    const rows = [dep("a", { calls: 30, errors: 3, p95Ms: 80 })];
    const data = depsAnswer(rows, {
      previousCovered: true,
      note: null,
      previousTotals: {
        dependencies: 2,
        calls: 20,
        errors: 0,
        slowestP95Ms: 40,
      },
    });
    const c = dependencyChanges(data, rows, false);
    expect(c.dependencies.text).toBe("-50%");
    expect(c.calls.text).toBe("+50%");
    expect(c.errorRate).toMatchObject({ text: "+10.0 pt", tone: "worse" });
    expect(c.slowest).toMatchObject({ tone: "worse" });
  });

  it("with a name filter sums the rows' own previous numbers", () => {
    const rows = [
      dep("a", { calls: 10, errors: 0, p95Ms: 20, previous: prev(5, 0, 10) }),
    ];
    const data = depsAnswer(rows, {
      previousCovered: true,
      note: null,
      // Totals of every target: not to be used while filtered.
      previousTotals: {
        dependencies: 9,
        calls: 900,
        errors: 0,
        slowestP95Ms: 1,
      },
    });
    expect(dependencyChanges(data, rows, true).calls.text).toBe("+100%");
  });

  it("is '—' with the reason when the previous window is not covered or the server is old", () => {
    const rows = [dep("a")];
    const young = dependencyChanges(
      depsAnswer(rows, { previousCovered: false, note: "too young" }),
      rows,
      false,
    );
    expect(young.calls).toMatchObject({ text: "—", title: "too young" });
    expect(young.slowest.text).toBe("—");
    const old = dependencyChanges(depsAnswer(rows), rows, false);
    expect(old.errorRate.text).toBe("—");
    expect(old.errorRate.title).toMatch(/does not send/);
  });

  it("row: p95 change, 'new' without a previous, '—' when not covered", () => {
    const covered = depsAnswer([], { previousCovered: true, note: null });
    expect(
      rowP95Change(
        dep("a", { p95Ms: 150, previous: prev(1, 0, 100) }),
        covered,
      ),
    ).toMatchObject({ tone: "worse" });
    expect(rowP95Change(dep("a"), covered).text).toBe("new");
    expect(
      rowP95Change(dep("a"), depsAnswer([], { previousCovered: false })).text,
    ).toBe("—");
  });
});

const cls = (
  className: string,
  over: Partial<ClassStats> = {},
): ClassStats => ({
  className,
  kind: "service",
  calls: 10,
  errors: 0,
  totalMs: 100,
  avgMs: 10,
  ownMs: 50,
  methods: [],
  ...over,
});
const classesAnswer = (
  classes: ClassStats[],
  over: Partial<ClassStatsResponse> = {},
): ClassStatsResponse => ({
  windowMinutes: 15,
  fromUnixMs: 0,
  toUnixMs: 1,
  methodsState: "on",
  methodsEnabled: true,
  classes,
  ...over,
});

describe("classChanges", () => {
  it("compares the summary with the previous totals", () => {
    const classes = [cls("A", { calls: 20, errors: 2, ownMs: 90 })];
    const data = classesAnswer(classes, {
      previousCovered: true,
      note: null,
      previousTotals: {
        classes: 1,
        calls: 10,
        errors: 0,
        totalMs: 80,
        ownMs: 60,
      },
    });
    const c = classChanges(data, summarizeClasses(classes));
    expect(c.calls.text).toBe("+100%");
    expect(c.errorRate).toMatchObject({ text: "+10.0 pt", tone: "worse" });
    expect(c.own.tone).toBe("worse");
    expect(c.classes.text).toBe("0%");
  });

  it("own time is '—' when either window has no estimate", () => {
    const classes = [cls("A", { ownMs: null })];
    const data = classesAnswer(classes, {
      previousCovered: true,
      note: null,
      previousTotals: {
        classes: 1,
        calls: 10,
        errors: 0,
        totalMs: 80,
        ownMs: 60,
      },
    });
    expect(classChanges(data, summarizeClasses(classes)).own.text).toBe("—");
  });

  it("is '—' everywhere when not covered; row avg change is new or a delta", () => {
    const classes = [cls("A")];
    const none = classChanges(
      classesAnswer(classes, { previousCovered: false, note: "kept 60 min" }),
      summarizeClasses(classes),
    );
    expect(none.calls).toMatchObject({ text: "—", title: "kept 60 min" });
    const covered = classesAnswer(classes, {
      previousCovered: true,
      note: null,
    });
    expect(rowAvgChange(cls("A"), covered).text).toBe("new");
    expect(
      rowAvgChange(
        cls("A", {
          avgMs: 5,
          previous: {
            calls: 1,
            errors: 0,
            totalMs: 10,
            avgMs: 10,
            ownMs: null,
          },
        }),
        covered,
      ),
    ).toMatchObject({ tone: "better" });
  });
});

const edge = (to: string, over: Partial<MapEdge> = {}): MapEdge => ({
  from: "app",
  to,
  calls: 10,
  errors: 1,
  p50Ms: 5,
  p95Ms: 50,
  ...over,
});
const mapAnswer = (
  edges: MapEdge[],
  over: Partial<AppMapResponse> = {},
): AppMapResponse => ({
  windowMinutes: 15,
  fromUnixMs: 0,
  toUnixMs: 1,
  nodes: [],
  edges,
  ...over,
});

describe("mapChanges", () => {
  it("compares the edges' totals and the target count with the previous totals", () => {
    const edges = [edge("db", { calls: 30, errors: 0, p95Ms: 20 })];
    const data = mapAnswer(edges, {
      previousCovered: true,
      note: null,
      previousTotals: { targets: 2, calls: 20, errors: 2, slowestP95Ms: 40 },
    });
    const c = mapChanges(data, edges, 1);
    expect(c.targets.text).toBe("-50%");
    expect(c.calls.text).toBe("+50%");
    expect(c.errorRate).toMatchObject({ tone: "better" });
    expect(c.slowest).toMatchObject({ tone: "better" });
  });

  it("is '—' when not covered; edge change is new, a delta or '—'", () => {
    const edges = [edge("db")];
    const none = mapChanges(
      mapAnswer(edges, { previousCovered: false, note: "young" }),
      edges,
      1,
    );
    expect(none.calls).toMatchObject({ text: "—", title: "young" });
    const covered = mapAnswer(edges, { previousCovered: true, note: null });
    expect(edgeP95Change(edge("db"), covered).text).toBe("new");
    expect(
      edgeP95Change(
        edge("db", {
          p95Ms: 200,
          previous: { calls: 1, errors: 0, p50Ms: 1, p95Ms: 100 },
        }),
        covered,
      ),
    ).toMatchObject({ tone: "worse" });
    expect(edgeP95Change(edge("db"), mapAnswer(edges)).text).toBe("—");
  });
});
