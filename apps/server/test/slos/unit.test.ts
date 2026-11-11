import { describe, expect, it } from "vitest";
import { validateRuleInput } from "../../src/alerts/store.js";
import {
  badRequests,
  burnRate,
  computeStatus,
  goodUnderThreshold,
  type Totals,
} from "../../src/slos/compute.js";
import { validateSloInput } from "../../src/slos/store.js";
import {
  bucketIndex,
  HISTOGRAM_BUCKETS,
  HISTOGRAM_UPPER_BOUNDS_MS,
} from "../../src/storage/histogram.js";

function totals(count: number, errors: number, durations: [number, number][]) {
  const hist = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  let maxMs = 0;
  for (const [ms, n] of durations) {
    hist[bucketIndex(ms)] = (hist[bucketIndex(ms)] ?? 0) + n;
    maxMs = Math.max(maxMs, ms);
  }
  return { count, errors, maxMs, hist } satisfies Totals;
}

describe("latency good-request estimate", () => {
  it("counts whole buckets under the threshold and none above it", () => {
    const t = totals(100, 0, [
      [10, 90],
      [5000, 10],
    ]);
    expect(goodUnderThreshold(t.hist, 100, t.maxMs)).toBe(90);
  });

  it("interpolates inside the bucket that holds the threshold", () => {
    const i = bucketIndex(50);
    const lo = HISTOGRAM_UPPER_BOUNDS_MS[i - 1] as number;
    const hi = HISTOGRAM_UPPER_BOUNDS_MS[i] as number;
    const hist = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
    hist[i] = 100;
    const mid = (lo + hi) / 2;
    expect(goodUnderThreshold(hist, mid, hi)).toBeCloseTo(50, 6);
    expect(goodUnderThreshold(hist, hi, hi)).toBe(100);
    expect(goodUnderThreshold(hist, lo, hi)).toBe(0);
  });
});

describe("status arithmetic", () => {
  const avail = {
    kind: "availability" as const,
    latency_threshold_ms: null,
    objective: 0.95,
  };

  it("availability: bad are the rollup's errors", () => {
    expect(badRequests(avail, totals(1000, 100, []))).toBe(100);
    // An inconsistent row cannot make more bad requests than requests.
    expect(badRequests(avail, totals(10, 99, []))).toBe(10);
  });

  it("burn rate is the bad fraction over the allowed fraction; null without requests", () => {
    expect(burnRate(avail, totals(1000, 100, []))).toBeCloseTo(2, 9);
    expect(burnRate(avail, totals(0, 0, []))).toBeNull();
  });

  it("budget: total, remaining, and an overspent budget goes negative", () => {
    const empty = totals(0, 0, []);
    const s = computeStatus(avail, totals(1000, 20, []), empty, empty);
    expect(s.attainment).toBeCloseTo(0.98, 9);
    expect(s.errorBudget.totalRequests).toBeCloseTo(50, 9);
    expect(s.errorBudget.remainingRequests).toBeCloseTo(30, 9);
    expect(s.errorBudget.remainingFraction).toBeCloseTo(0.6, 9);
    expect(s.breached).toBe(false);
    const over = computeStatus(avail, totals(1000, 100, []), empty, empty);
    expect(over.errorBudget.remainingFraction).toBeCloseTo(-1, 9);
    expect(over.breached).toBe(true);
    const none = computeStatus(avail, empty, empty, empty);
    expect(none.attainment).toBeNull();
    expect(none.errorBudget.remainingFraction).toBeNull();
    expect(none.breached).toBe(false);
  });
});

describe("SLO input validation", () => {
  const ok = {
    name: "Checkout availability",
    service: "shop",
    kind: "availability",
    objective: 0.999,
    windowDays: 30,
  };

  it("accepts a valid availability and a valid latency SLO", () => {
    expect(validateSloInput(ok, false)).toMatchObject({ ok: true });
    expect(
      validateSloInput(
        { ...ok, kind: "latency", latencyThresholdMs: 300, route: "/orders" },
        false,
      ),
    ).toMatchObject({
      ok: true,
      fields: { latency_threshold_ms: 300, route: "/orders" },
    });
  });

  it.each([
    [{ ...ok, objective: 1 }, "objective"],
    [{ ...ok, objective: 0 }, "objective"],
    [{ ...ok, objective: "0.9" }, "objective"],
    [{ ...ok, windowDays: 14 }, "windowDays"],
    [{ ...ok, kind: "latency" }, "latencyThresholdMs is required"],
    [{ ...ok, latencyThresholdMs: 100 }, "only for a latency"],
    [{ ...ok, kind: "latency", latencyThresholdMs: -1 }, "latencyThresholdMs"],
    [{ ...ok, extra: 1 }, "Unknown field"],
    [{ ...ok, name: "" }, "name"],
    [{ name: "x" }, "required"],
    [[], "JSON object"],
  ])("refuses %j", (body, message) => {
    const v = validateSloInput(body, false);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.message).toContain(message);
  });

  it("an update checks the kind against the stored threshold", () => {
    const stored = { kind: "latency" as const, latency_threshold_ms: 200 };
    expect(validateSloInput({ objective: 0.99 }, true, stored).ok).toBe(true);
    expect(
      validateSloInput({ kind: "availability" }, true, stored),
    ).toMatchObject({ ok: true, fields: { latency_threshold_ms: null } });
    const avail = { kind: "availability" as const, latency_threshold_ms: null };
    expect(validateSloInput({ kind: "latency" }, true, avail).ok).toBe(false);
  });
});

describe("burn-rate rule validation", () => {
  const base = {
    name: "Burn",
    metric: "slo_burn_rate",
    sloId: "3",
    threshold: 14.4,
    windowMinutes: 60,
    webhookUrl: "https://hooks.example.com/x",
  };
  const hosts = ["hooks.example.com"];

  it("needs sloId, takes no service, and bounds the threshold", () => {
    expect(validateRuleInput(base, false, hosts)).toMatchObject({
      ok: true,
      fields: { slo_id: 3, metric: "slo_burn_rate" },
    });
    expect(
      validateRuleInput({ ...base, sloId: undefined }, false, hosts).ok,
    ).toBe(false);
    expect(
      validateRuleInput({ ...base, service: "shop" }, false, hosts).ok,
    ).toBe(false);
    expect(validateRuleInput({ ...base, threshold: 0 }, false, hosts).ok).toBe(
      false,
    );
    expect(
      validateRuleInput({ ...base, threshold: 5000 }, false, hosts).ok,
    ).toBe(false);
  });

  it("sloId belongs to slo_burn_rate only; other metrics still need a service", () => {
    const other = {
      ...base,
      metric: "error_rate",
      threshold: 0.1,
      service: "shop",
    };
    expect(validateRuleInput(other, false, hosts).ok).toBe(false);
    const { sloId: _drop, ...noSlo } = other;
    expect(validateRuleInput(noSlo, false, hosts).ok).toBe(true);
    const { service: _s, ...noService } = noSlo;
    expect(validateRuleInput(noService, false, hosts).ok).toBe(false);
  });
});
