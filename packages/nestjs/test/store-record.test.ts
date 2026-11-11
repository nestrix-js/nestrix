// `buildRecord` on one fixed span: the cleaned attributes and the exact byte estimate.
import { describe, expect, it } from "vitest";
import type { RedactedFields } from "../src/otel/redaction.js";
import { buildRecord, type SpanIdentity } from "../src/store/record.js";

describe("buildRecord on a fixed span", () => {
  it("removes null holes from span and event arrays and pins the byte estimate", () => {
    const span = {
      name: "GET /fixed",
      kind: 1,
      startTime: [1_700_000_000, 0],
      duration: [0, 5_000_000],
      events: [{ name: "evt", time: [1_700_000_000, 500_000_000] }],
      links: [],
      instrumentationScope: { name: "@nestrix/nestjs" },
    };
    const identity: SpanIdentity = {
      traceId: "00000000000000000000000000000001",
      spanId: "00000000000000a1",
      parentSpanId: undefined,
      localRoot: true,
    };
    const fields: RedactedFields = {
      outcome: "keep",
      attributes: {
        "http.route": "/fixed",
        holes: ["x", null, "y", undefined] as never,
        arrow: "a→b",
        latin: "café",
      },
      eventAttributes: [{ tags: [null, "t1", null] as never }],
      status: { code: 0 },
    };

    const built = buildRecord(span, identity, fields);

    expect(built.record.attributes).toEqual({
      "http.route": "/fixed",
      holes: ["x", "y"],
      arrow: "a→b",
      latin: "café",
    });
    expect(built.record.events).toEqual([
      {
        name: "evt",
        timeUnixMs: 1_700_000_000_500,
        attributes: { tags: ["t1"] },
      },
    ]);
    // Pins cleanAndMeasure's estimate for this span. Any change to the byte formula
    // in record.ts must update this number on purpose.
    expect(built.bytes).toBe(760);
  });
});
