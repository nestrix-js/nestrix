/** `NESTRIX_LOGS=all` mapping (issue #17, D-106): traceless records and the truncated flag. */
import { describe, expect, it } from "vitest";
import { decodeLogsRequest } from "../../src/ingest/decode.js";
import { toIngestLogBatch } from "../../src/ingest/map-logs.js";

const TRACE = "0123456789abcdef0123456789abcdef";
const now = BigInt(Date.now()) * 1_000_000n;

function request(records: object[]) {
  const body = {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "svc" } }],
        },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
  return decodeLogsRequest(Buffer.from(JSON.stringify(body)), "json", {
    maxSpans: 100_000,
    maxMessages: 400_000,
    maxJsonTokens: 1_200_000,
    maxDepth: 64,
  });
}

const traced = {
  timeUnixNano: String(now),
  body: { stringValue: "traced" },
  traceId: TRACE,
};
const traceless = {
  timeUnixNano: String(now),
  body: { stringValue: "startup" },
  spanId: "00000000000000a1",
};
const timeless = { body: { stringValue: "no time" } };

describe("traceless log records", () => {
  it("default: dropped, not rejected, exactly as before", () => {
    const batch = toIngestLogBatch(request([traced, traceless, timeless]));
    expect(batch.rejectedLogRecords).toBe(0);
    const records = batch.resourceLogs[0]?.records ?? [];
    expect(records.map((r) => r.body)).toEqual(["traced"]);
  });

  it("all: kept with an empty trace id and no span id; still needs a time", () => {
    const batch = toIngestLogBatch(
      request([traced, traceless, timeless]),
      now,
      {
        keepTraceless: true,
      },
    );
    const records = batch.resourceLogs[0]?.records ?? [];
    expect(records.map((r) => [r.body, r.traceId])).toEqual([
      ["traced", TRACE],
      ["startup", ""],
    ]);
    expect(records[1]?.spanId).toBeUndefined();
    expect(batch.rejectedLogRecords).toBe(1);
    expect(batch.errorMessage).toMatch(/missing time \(1\)/);
  });

  it("flags a body cut to 8,192 characters", () => {
    const long = { ...traced, body: { stringValue: "x".repeat(9000) } };
    const records =
      toIngestLogBatch(request([long, traced])).resourceLogs[0]?.records ?? [];
    expect(records[0]?.truncated).toBe(true);
    expect(records[0]?.body.length).toBe(8193);
    expect(records[1]?.truncated).toBeUndefined();
  });
});
