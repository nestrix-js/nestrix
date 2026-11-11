import type { SpanRecord } from "@nestrix/protocol";
import { describe, expect, it } from "vitest";

import { isDbSpan, isSlowDbSpan, repeatedQueries } from "@/lib/trace-insights";

const span = (
  id: string,
  durationMs: number,
  attributes: SpanRecord["attributes"] = {},
): SpanRecord => ({
  spanId: id,
  name: id,
  kind: "client",
  startTimeUnixMs: 0,
  durationMs,
  attributes,
  events: [],
  status: { code: "unset" },
  links: [],
});
const db = (id: string, ms: number, text?: string) =>
  span(id, ms, {
    "db.system.name": "postgresql",
    ...(text === undefined ? {} : { "db.query.text": text }),
  });

describe("slow database spans", () => {
  it("is slow only above 100 ms and only for a database span", () => {
    expect(isSlowDbSpan(db("a", 100.5))).toBe(true);
    expect(isSlowDbSpan(db("a", 100))).toBe(false);
    expect(isSlowDbSpan(span("a", 500))).toBe(false);
  });
  it("accepts the legacy db.system attribute", () => {
    const legacy = span("a", 150, { "db.system": "mysql" });
    expect(isDbSpan(legacy)).toBe(true);
    expect(isSlowDbSpan(legacy)).toBe(true);
  });
});

describe("repeatedQueries", () => {
  it("groups by statement from three occurrences, with count, total and span ids", () => {
    const groups = repeatedQueries([
      db("1", 10, "SELECT 1"),
      db("2", 20, "SELECT 1"),
      db("3", 30, "SELECT 1"),
      db("4", 5, "SELECT 2"),
      db("5", 5, "SELECT 2"),
    ]);
    expect(groups).toEqual([
      { text: "SELECT 1", count: 3, totalMs: 60, spanIds: ["1", "2", "3"] },
    ]);
  });
  it("orders by total time and ignores non-database spans and missing text", () => {
    const groups = repeatedQueries([
      db("1", 1, "A"),
      db("2", 1, "A"),
      db("3", 1, "A"),
      db("4", 50, "B"),
      db("5", 50, "B"),
      db("6", 50, "B"),
      db("7", 50, undefined),
      db("8", 50, undefined),
      db("9", 50, undefined),
      span("10", 99, { "db.query.text": "C" }),
      span("11", 99, { "db.query.text": "C" }),
      span("12", 99, { "db.query.text": "C" }),
    ]);
    expect(groups.map((g) => g.text)).toEqual(["B", "A"]);
  });
  it("returns nothing when no statement repeats", () => {
    expect(repeatedQueries([db("1", 1, "A"), db("2", 1, "A")])).toEqual([]);
  });
});
