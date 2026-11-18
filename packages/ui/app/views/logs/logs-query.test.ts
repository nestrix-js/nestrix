import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOG_FILTERS,
  dropSummary,
  isTraceId,
  logQuery,
} from "@/views/logs/logs-query";

const NOW = 1_800_000_000_000;

describe("logQuery", () => {
  it("bounds the window at now and drops empty filters", () => {
    expect(logQuery(DEFAULT_LOG_FILTERS, NOW)).toEqual({
      fromUnixMs: NOW - 3_600_000,
      toUnixMs: NOW,
      text: undefined,
      match: undefined,
      severity: undefined,
      service: undefined,
      traceId: undefined,
      limit: 100,
    });
  });

  it("passes the filters and ignores a malformed trace id", () => {
    const q = logQuery(
      {
        ...DEFAULT_LOG_FILTERS,
        text: " refused ",
        match: "substring",
        severity: "warn",
        window: "7d",
        service: "billing",
        traceId: "nope",
      },
      NOW,
    );
    expect(q).toMatchObject({
      fromUnixMs: NOW - 7 * 86_400_000,
      text: "refused",
      match: "substring",
      severity: "warn",
      service: "billing",
      traceId: undefined,
    });
    expect(isTraceId("nope")).toBe(false);
    expect(isTraceId("A".repeat(32))).toBe(true);
    expect(isTraceId("")).toBe(true);
  });
});

describe("dropSummary", () => {
  it("is null with no drops and names each reason otherwise", () => {
    expect(
      dropSummary({ total: 0, rateCap: 0, traceCap: 0, outOfRange: 0 }),
    ).toBeNull();
    expect(
      dropSummary({ total: 7, rateCap: 5, traceCap: 2, outOfRange: 0 }),
    ).toBe(
      "7 lines dropped (5 over the per-minute budget, 2 over the per-trace maximum)",
    );
    expect(
      dropSummary({ total: 1, rateCap: 0, traceCap: 0, outOfRange: 1 }),
    ).toBe("1 line dropped (1 outside the retention)");
  });
});
