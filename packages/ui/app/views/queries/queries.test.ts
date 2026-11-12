import type { QueryStatement } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  callsPerTrace,
  filterByText,
  formatPerTrace,
  isTruncated,
  onlyRepeated,
  PREVIEW_CHARS,
  preview,
  shortStatement,
  summarizeQueries,
  topBy,
} from "./queries";

const q = (repeatedTraces: number): QueryStatement => ({
  statement: "SELECT 1",
  system: "postgresql",
  kind: "database",
  count: 1,
  totalMs: 1,
  avgMs: 1,
  p95Ms: 1,
  maxMs: 1,
  errors: 0,
  traces: 1,
  repeatedTraces,
  exampleTraceIds: [],
});

describe("preview", () => {
  it("folds whitespace and leaves short statements whole", () => {
    expect(preview("SELECT *\n  FROM t")).toBe("SELECT * FROM t");
    expect(isTruncated("SELECT 1")).toBe(false);
  });

  it("cuts long statements with an ellipsis", () => {
    const long = "x".repeat(PREVIEW_CHARS + 30);
    expect(preview(long)).toBe(`${"x".repeat(PREVIEW_CHARS)}…`);
    expect(isTruncated(long)).toBe(true);
  });
});

describe("filterByText", () => {
  const a = {
    ...q(0),
    statement: "SELECT *\n  FROM order_items WHERE id = $1",
  };
  const b = { ...q(0), statement: "INSERT INTO orders VALUES ($1)" };
  it("matches case-insensitively with whitespace folded", () => {
    expect(filterByText([a, b], "select * from ORDER_ITEMS")).toEqual([a]);
  });
  it("keeps everything without a filter", () => {
    expect(filterByText([a, b], null)).toHaveLength(2);
    expect(filterByText([a, b], "  ")).toHaveLength(2);
  });
  it("finds nothing for text no statement holds", () => {
    expect(filterByText([a, b], "DELETE")).toEqual([]);
  });
});

const full = (
  statement: string,
  count: number,
  avgMs: number,
  extra: Partial<QueryStatement> = {},
): QueryStatement => ({
  ...q(0),
  statement,
  count,
  avgMs,
  totalMs: count * avgMs,
  ...extra,
});

describe("shortStatement", () => {
  it("folds whitespace and cuts at the given length", () => {
    expect(shortStatement("SELECT *\n FROM t")).toBe("SELECT * FROM t");
    expect(shortStatement("abcdef", 4)).toBe("abcd…");
    expect(shortStatement("abcd", 4)).toBe("abcd");
  });
});

describe("topBy", () => {
  const list = [
    full("a", 5, 1),
    full("b", 1, 9),
    full("c", 3, 4),
    full("z", 0, 0),
  ];
  it("ranks by the key, largest first, and drops zeros", () => {
    expect(topBy(list, "avgMs").map((x) => x.statement)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(topBy(list, "count", 2).map((x) => x.statement)).toEqual(["a", "c"]);
  });
  it("does not reorder the input", () => {
    topBy(list, "count");
    expect(list.map((x) => x.statement)).toEqual(["a", "b", "c", "z"]);
  });
});

describe("callsPerTrace", () => {
  it("divides calls by the traces they ran in", () => {
    expect(callsPerTrace({ count: 12, traces: 3 })).toBe(4);
    expect(callsPerTrace({ count: 5, traces: 0 })).toBe(5);
    expect(formatPerTrace(1)).toBe("1");
    expect(formatPerTrace(4.25)).toBe("4.3");
    expect(formatPerTrace(12.4)).toBe("12");
  });
});

describe("summarizeQueries", () => {
  it("counts statements, total time, N+1 candidates and the slowest mean", () => {
    const s = summarizeQueries([
      full("a", 10, 2, { repeatedTraces: 2 }),
      full("b", 1, 30),
      full("c", 4, 1, { repeatedTraces: 1 }),
    ]);
    expect(s.statements).toBe(3);
    expect(s.totalMs).toBe(20 + 30 + 4);
    expect(s.nPlusOne).toBe(2);
    expect(s.slowest?.statement).toBe("b");
    expect(summarizeQueries([])).toEqual({
      statements: 0,
      totalMs: 0,
      nPlusOne: 0,
      slowest: null,
    });
  });
});

describe("onlyRepeated", () => {
  it("keeps only N+1 candidates when enabled", () => {
    const list = [q(0), q(2)];
    expect(onlyRepeated(list, true)).toEqual([list[1]]);
    expect(onlyRepeated(list, false)).toHaveLength(2);
  });
});
