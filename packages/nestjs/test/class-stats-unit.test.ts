// No global state. Unit tests for the class statistics (P3-04): bucketing, window, bounds,
// errors, maximum, own time from synthetic stored spans.
import { describe, expect, it } from "vitest";
import {
  ClassStatistics,
  MAX_CLASSES,
  MAX_METHODS_PER_CLASS,
  OTHER,
  ownAverages,
} from "../src/stats/class-stats.js";
import { BUCKET_MS } from "../src/stats/route-stats.js";
import { getOrCreateStore } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot, spanId } from "./store-helpers.js";

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0); // a minute boundary

describe("ClassStatistics", () => {
  it("sums calls, errors, total and max per method, and orders by total", () => {
    const s = new ClassStatistics(T0);
    s.recordAt("A", "service", "slow", 100, false, T0);
    s.recordAt("A", "service", "slow", 300, true, T0 + 1000);
    s.recordAt("A", "service", "fast", 1, false, T0);
    s.recordAt("B", "repository", "q", 1000, false, T0);
    const r = s.query(15, true, undefined, T0 + 2000);
    expect(r.classes.map((c) => c.className)).toEqual(["B", "A"]);
    const a = r.classes[1];
    expect(a).toMatchObject({
      kind: "service",
      calls: 3,
      errors: 1,
      totalMs: 401,
      ownMs: null,
    });
    expect(a?.avgMs).toBeCloseTo(401 / 3, 2);
    expect(a?.methods.map((m) => m.method)).toEqual(["slow", "fast"]);
    expect(a?.methods[0]).toEqual({
      method: "slow",
      calls: 2,
      errors: 1,
      totalMs: 400,
      avgMs: 200,
      maxMs: 300,
      ownAvgMs: null,
    });
    expect(r.methodsEnabled).toBe(true);
  });

  it("buckets by wall-clock minute and leaves out calls older than the window", () => {
    const s = new ClassStatistics(T0);
    s.recordAt("A", "service", "m", 10, false, T0); // minute 0
    s.recordAt("A", "service", "m", 20, false, T0 + 20 * BUCKET_MS);
    const now = T0 + 20 * BUCKET_MS + 5;
    const r15 = s.query(15, true, undefined, now);
    expect(r15.classes[0]?.calls).toBe(1);
    expect(r15.classes[0]?.methods[0]?.maxMs).toBe(20);
    expect(r15.fromUnixMs).toBe(T0 + 6 * BUCKET_MS);
    const r60 = s.query(60, true, undefined, now);
    expect(r60.classes[0]?.calls).toBe(2);
    // An hour later the first slot is reused: the stale count is cleared, not added to.
    s.recordAt("A", "service", "m", 5, false, T0 + 60 * BUCKET_MS);
    const later = s.query(60, true, undefined, T0 + 60 * BUCKET_MS);
    expect(later.classes[0]?.calls).toBe(2); // minutes 20 and 60
    expect(later.classes[0]?.totalMs).toBe(25);
  });

  it("leaves out classes with no call in the window", () => {
    const s = new ClassStatistics(T0);
    s.recordAt("Old", "service", "m", 10, false, T0);
    const r = s.query(15, true, undefined, T0 + 30 * BUCKET_MS);
    expect(r.classes).toEqual([]);
  });

  it("bounds methods per class: the rest count under (other)", () => {
    const s = new ClassStatistics(T0);
    for (let i = 0; i < MAX_METHODS_PER_CLASS + 5; i++) {
      s.recordAt("A", "service", `m${i}`, 1, false, T0);
    }
    const r = s.query(15, true, undefined, T0);
    const methods = r.classes[0]?.methods ?? [];
    expect(methods).toHaveLength(MAX_METHODS_PER_CLASS + 1);
    expect(methods.find((m) => m.method === OTHER)?.calls).toBe(5);
    expect(r.classes[0]?.calls).toBe(MAX_METHODS_PER_CLASS + 5);
  });

  it("bounds classes: the rest count under the (other) class", () => {
    const s = new ClassStatistics(T0);
    for (let i = 0; i < MAX_CLASSES + 7; i++) {
      s.recordAt(`C${i}`, "service", "m", 1, false, T0);
    }
    expect(s.classCount).toBe(MAX_CLASSES);
    const r = s.query(15, true, undefined, T0);
    expect(r.classes).toHaveLength(MAX_CLASSES + 1);
    const other = r.classes.find((c) => c.className === OTHER);
    expect(other).toMatchObject({ calls: 7, kind: "provider" });
    expect(other?.methods).toHaveLength(1);
    // A known class still counts under its own name.
    s.recordAt("C0", "service", "m", 1, false, T0);
    expect(
      s.query(15, true, undefined, T0).classes.find((c) => c.className === "C0")
        ?.calls,
    ).toBe(2);
  });

  it("never throws and sanitises durations and times", () => {
    const s = new ClassStatistics(T0);
    s.recordAt("A", "service", "m", Number.NaN, false, T0);
    s.recordAt("A", "service", "m", -5, false, T0);
    s.recordAt("A", "service", "m", Number.POSITIVE_INFINITY, false, T0);
    s.recordAt("A", "service", "ignored", 1, false, Number.NaN);
    const r = s.query(Number.NaN, true, undefined, Number.NaN);
    expect(r.windowMinutes).toBe(1);
    const r2 = s.query(15, true, undefined, T0);
    expect(r2.classes[0]).toMatchObject({ calls: 3, totalMs: 0 });
    expect(r2.classes[0]?.methods.map((m) => m.method)).toEqual(["m"]);
  });

  it("record() stamps the current time", () => {
    const s = new ClassStatistics();
    expect(s.hasRecorded).toBe(false);
    s.record("A", "guard", "canActivate", 2, false);
    expect(s.hasRecorded).toBe(true);
    expect(s.query(15, true).classes[0]).toMatchObject({
      className: "A",
      kind: "guard",
      calls: 1,
    });
  });

  it("attaches own averages: ownMs sums ownAvgMs * calls, null without estimate", () => {
    const s = new ClassStatistics(T0);
    for (let i = 0; i < 4; i++) s.recordAt("A", "service", "a", 10, false, T0);
    for (let i = 0; i < 2; i++) s.recordAt("A", "service", "b", 10, false, T0);
    s.recordAt("Z", "service", "z", 10, false, T0);
    const own = new Map([["A", new Map([["a", 2.5]])]]);
    const r = s.query(15, true, own, T0);
    const a = r.classes.find((c) => c.className === "A");
    expect(a?.ownMs).toBe(10);
    expect(a?.methods.find((m) => m.method === "a")?.ownAvgMs).toBe(2.5);
    expect(a?.methods.find((m) => m.method === "b")?.ownAvgMs).toBeNull();
    expect(r.classes.find((c) => c.className === "Z")?.ownMs).toBeNull();
  });
});

describe("ownAverages from stored spans", () => {
  it("is duration minus direct children, clipped at 0, averaged over the window", () => {
    const store = getOrCreateStore({}, recordingDiagnostics());
    const detach = store.attach({});
    try {
      const base = T0;
      const root = spanId();
      const svc1 = spanId();
      const svc2 = spanId();
      const grand = spanId();
      const attrs = (m: string) => ({
        "nestrix.class": "OrderService",
        "nestrix.method": m,
      });
      // Trace 1: root -> svc1 (100 ms) -> db child (30) + db child (20); a grandchild does not count.
      store.enqueue(
        fakeSpan({
          trace: 1,
          id: grand,
          parent: { spanId: spanId() },
          startMs: base,
          durationMs: 999,
        }),
      );
      store.enqueue(
        fakeSpan({
          trace: 1,
          parent: { spanId: svc1 },
          startMs: base,
          durationMs: 30,
          kind: 2,
        }),
      );
      store.enqueue(
        fakeSpan({
          trace: 1,
          parent: { spanId: svc1 },
          startMs: base,
          durationMs: 20,
          kind: 2,
        }),
      );
      store.enqueue(
        fakeSpan({
          trace: 1,
          id: svc1,
          parent: { spanId: root },
          startMs: base,
          durationMs: 100,
          attributes: attrs("place"),
        }),
      );
      store.enqueue(
        serverRoot(1, { id: root, startMs: base, durationMs: 120 }),
      );
      // Trace 2: the same method, 40 ms with children summing to 70 (parallel): own clips to 0.
      store.enqueue(
        fakeSpan({
          trace: 2,
          parent: { spanId: svc2 },
          startMs: base,
          durationMs: 40,
          kind: 2,
        }),
      );
      store.enqueue(
        fakeSpan({
          trace: 2,
          parent: { spanId: svc2 },
          startMs: base,
          durationMs: 30,
          kind: 2,
        }),
      );
      store.enqueue(
        fakeSpan({
          trace: 2,
          id: svc2,
          startMs: base,
          durationMs: 40,
          attributes: attrs("place"),
        }),
      );
      // A leaf method with no children: own = duration. And one started before the window.
      store.enqueue(
        fakeSpan({
          trace: 3,
          startMs: base,
          durationMs: 8,
          attributes: attrs("leaf"),
        }),
      );
      store.enqueue(
        fakeSpan({
          trace: 4,
          startMs: base - 3_600_000,
          durationMs: 500,
          attributes: attrs("old"),
        }),
      );
      // Not a method span.
      store.enqueue(
        fakeSpan({
          trace: 5,
          startMs: base,
          durationMs: 77,
          attributes: { "nestrix.class": "OnlyClass" },
        }),
      );
      store.drainNow();

      const own = ownAverages((v) => store.scanAllTraces(v), base - 1000);
      // place: (100 - 50 = 50) and (40 - 70 -> 0): average 25.
      expect(own.get("OrderService")?.get("place")).toBe(25);
      expect(own.get("OrderService")?.get("leaf")).toBe(8);
      expect(own.get("OrderService")?.has("old")).toBe(false);
      expect(own.has("OnlyClass")).toBe(false);
    } finally {
      detach();
    }
  });

  it("returns an empty map when the scan throws", () => {
    const own = ownAverages(() => {
      throw new Error("boom");
    }, 0);
    expect(own.size).toBe(0);
  });
});
