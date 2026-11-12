import type { QueryStatement } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  filterByText,
  isTruncated,
  onlyRepeated,
  PREVIEW_CHARS,
  preview,
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

describe("onlyRepeated", () => {
  it("keeps only N+1 candidates when enabled", () => {
    const list = [q(0), q(2)];
    expect(onlyRepeated(list, true)).toEqual([list[1]]);
    expect(onlyRepeated(list, false)).toHaveLength(2);
  });
});
