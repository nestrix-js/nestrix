import type { TraceSummary, TraceTimelineResponse } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  formatErrorShare,
  percentile,
  slowestInWindow,
  statusTone,
  timelineTotals,
} from "@/views/requests/requests-stats";

const timeline = (
  buckets: [number, number, number][],
): TraceTimelineResponse => ({
  windowMinutes: 15,
  fromUnixMs: 0,
  toUnixMs: buckets.length * 60_000,
  bucketMs: 60_000,
  buckets: buckets.map(([ok, clientError, serverError], i) => ({
    startUnixMs: i * 60_000,
    ok,
    clientError,
    serverError,
  })),
});

const trace = (id: string, startTimeUnixMs: number, durationMs: number) =>
  ({ traceId: id, startTimeUnixMs, durationMs }) as TraceSummary;

describe("timelineTotals", () => {
  it("adds the buckets up and finds the server error rate", () => {
    const totals = timelineTotals(
      timeline([
        [8, 1, 1],
        [0, 0, 0],
        [9, 0, 1],
      ]),
    );
    expect(totals.total).toBe(20);
    expect(totals.clientErrors).toBe(1);
    expect(totals.serverErrors).toBe(2);
    expect(totals.errorRate).toBeCloseTo(0.1);
    expect(totals.perBucket).toEqual([10, 0, 10]);
    expect(totals.serverPerBucket).toEqual([1, 0, 1]);
  });
  it("is all zeros before the first answer", () => {
    const totals = timelineTotals(undefined);
    expect(totals.total).toBe(0);
    expect(totals.errorRate).toBe(0);
    expect(totals.perBucket).toEqual([]);
  });
});

describe("formatErrorShare", () => {
  it("shows a dash when nothing was requested, else the share", () => {
    expect(formatErrorShare(timelineTotals(timeline([[0, 0, 0]])))).toBe("—");
    expect(formatErrorShare(timelineTotals(timeline([[99, 0, 1]])))).toBe(
      "1.0%",
    );
  });
});

describe("percentile", () => {
  it("takes the nearest rank", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBe(19);
    expect(percentile(values, 1)).toBe(20);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([5], 0.95)).toBe(5);
  });
  it("does not depend on the input order and leaves it alone", () => {
    const values = [9, 1, 5];
    expect(percentile(values, 0.5)).toBe(5);
    expect(values).toEqual([9, 1, 5]);
  });
  it("is null for no values", () => {
    expect(percentile([], 0.95)).toBeNull();
  });
});

describe("slowestInWindow", () => {
  const items = [
    trace("a", 1000, 50),
    trace("b", 2000, 900),
    trace("c", 3000, 400),
    trace("d", 9000, 5000),
  ];
  it("picks the slowest one that started inside the window", () => {
    expect(slowestInWindow(items, 0, 5000)?.traceId).toBe("b");
  });
  it("includes the start and excludes the end of the window", () => {
    expect(slowestInWindow(items, 1000, 2000)?.traceId).toBe("a");
    expect(slowestInWindow(items, 9000, 9001)?.traceId).toBe("d");
  });
  it("is null when none started inside", () => {
    expect(slowestInWindow(items, 10_000, 20_000)).toBeNull();
    expect(slowestInWindow([], 0, 1)).toBeNull();
  });
});

describe("statusTone", () => {
  it("marks 5xx worse and 4xx caution, the rest plain", () => {
    expect(statusTone(503)).toBe("worse");
    expect(statusTone(404)).toBe("warn");
    expect(statusTone(302)).toBe("neutral");
    expect(statusTone(200)).toBe("neutral");
  });
});
