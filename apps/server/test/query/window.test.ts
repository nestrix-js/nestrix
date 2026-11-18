/** Time ranges of the aggregate routes (issue #29, D-107): the pure resolution rules. */
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  bucketMsFor,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  resolveWindow,
  windowOf,
  windowOptionsFor,
} from "../../src/query/window.js";

const NOW = Date.UTC(2026, 10, 18, 12, 20, 30);
const opts = { retentionDays: 7, defaultWindowMinutes: 15, now: NOW };

function status(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as { error: { message: string } };
      return { status: error.getStatus(), message: body.error.message };
    }
    throw error;
  }
  throw new Error("did not throw");
}

describe("bucketMsFor", () => {
  it("grows with the window: 1 min, 5 min, 1 h, 1 day", () => {
    expect(bucketMsFor(15)).toBe(MINUTE_MS);
    expect(bucketMsFor(60)).toBe(5 * MINUTE_MS);
    expect(bucketMsFor(60, true)).toBe(MINUTE_MS);
    expect(bucketMsFor(360)).toBe(5 * MINUTE_MS);
    expect(bucketMsFor(1440)).toBe(HOUR_MS);
    expect(bucketMsFor(10_080)).toBe(HOUR_MS);
    expect(bucketMsFor(43_200)).toBe(DAY_MS);
  });
});

describe("windowOf", () => {
  it("is the last N minutes with one-minute buckets", () => {
    const w = windowOf(15, NOW);
    expect(w.buckets).toBe(15);
    expect(w.last - w.first + 1).toBe(15);
    expect(w.fromMs).toBe(
      Math.floor(NOW / MINUTE_MS) * MINUTE_MS - 14 * MINUTE_MS,
    );
  });

  it("holds whole hours for 24 h and 7 d, ending at the current hour", () => {
    const day = windowOf(1440, NOW, HOUR_MS);
    expect(day.buckets).toBe(24);
    expect(day.fromMs % HOUR_MS).toBe(0);
    expect(NOW - day.fromMs).toBeGreaterThanOrEqual(23 * HOUR_MS);
    expect(NOW - day.fromMs).toBeLessThan(24 * HOUR_MS);
    expect(windowOf(10_080, NOW, HOUR_MS).buckets).toBe(168);
    expect(windowOf(43_200, NOW, DAY_MS).buckets).toBe(30);
  });
});

describe("resolveWindow", () => {
  it("takes the default, or windowMinutes, ending now", () => {
    expect(resolveWindow({}, opts)).toEqual({ windowMinutes: 15, now: NOW });
    expect(resolveWindow({ windowMinutes: 1440 }, opts)).toEqual({
      windowMinutes: 1440,
      now: NOW,
    });
  });

  it("refuses a window longer than the retention, naming it", () => {
    const e = status(() => resolveWindow({ windowMinutes: 43_200 }, opts));
    expect(e.status).toBe(400);
    expect(e.message).toContain("retention of 7 days");
    expect(
      resolveWindow({ windowMinutes: 43_200 }, { ...opts, retentionDays: 30 })
        .windowMinutes,
    ).toBe(43_200);
  });

  it("widens a range to whole buckets that hold both ends", () => {
    const from = NOW - 26 * HOUR_MS - 7 * MINUTE_MS;
    const r = resolveWindow({ fromUnixMs: from, toUnixMs: NOW }, opts);
    const bucket = bucketMsFor(r.windowMinutes);
    expect(bucket).toBe(HOUR_MS);
    expect((r.windowMinutes * MINUTE_MS) % bucket).toBe(0);
    const w = windowOf(r.windowMinutes, r.now, bucket);
    expect(w.fromMs).toBeLessThanOrEqual(from);
    expect(r.now).toBe(NOW);
  });

  it("ends a range that ends a little in the future at the server's clock", () => {
    const r = resolveWindow(
      { fromUnixMs: NOW - HOUR_MS, toUnixMs: NOW + 2 * MINUTE_MS },
      opts,
    );
    expect(r.now).toBe(NOW);
  });

  it.each([
    [
      { windowMinutes: 60, fromUnixMs: 1, toUnixMs: NOW },
      "cannot be used together",
    ],
    [{ fromUnixMs: NOW - HOUR_MS }, "must be given together"],
    [{ toUnixMs: NOW }, "must be given together"],
    [{ fromUnixMs: NOW, toUnixMs: NOW - HOUR_MS }, "must be after"],
    [{ fromUnixMs: NOW - 30_000, toUnixMs: NOW }, "at least a minute"],
    [{ fromUnixMs: NOW - 8 * DAY_MS, toUnixMs: NOW }, "retention of 7 days"],
    [{ fromUnixMs: NOW, toUnixMs: NOW + DAY_MS }, "too far in the future"],
  ])("answers 400 to %j", (values, text) => {
    const e = status(() => resolveWindow(values, opts));
    expect(e.status).toBe(400);
    expect(e.message).toContain(text);
  });
});

describe("windowOptionsFor", () => {
  it("lists the windows within the retention", () => {
    expect(windowOptionsFor(1)).toEqual([15, 60, 360, 1440]);
    expect(windowOptionsFor(7)).toEqual([15, 60, 360, 1440, 10_080]);
    expect(windowOptionsFor(30)).toEqual([15, 60, 360, 1440, 10_080, 43_200]);
  });
});
