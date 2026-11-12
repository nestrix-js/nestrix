// P9-04: the standalone server's copy of the message normaliser and grouping; the same cases as
// `packages/nestjs/test/error-groups-unit.test.ts`.
import { describe, expect, it } from "vitest";
import {
  type ErrorOccurrence,
  groupErrors,
  normaliseMessage,
} from "../../src/query/error-groups.js";

describe("normaliseMessage", () => {
  it.each([
    ["user 42 not found", "user <n> not found"],
    ["user 7 not found", "user <n> not found"],
    ["order #1234 failed after 3.5s", "order #<n> failed after <n>s"],
    ["No row for 3f2504e0-4f89-41d3-9a0c-0305e82c3301", "No row for <uuid>"],
    ["bad token 9f86d081884c7d65 rejected", "bad token <hex> rejected"],
    ["pointer 0xDEADBEEF", "pointer <hex>"],
    ["mail to alice.smith+x@example.co.uk bounced", "mail to <email> bounced"],
    [
      `Unknown column "total_price" in 'orders'`,
      "Unknown column <str> in <str>",
    ],
    ["key `abc 123` missing", "key <str> missing"],
    // An apostrophe inside a word is not a quote.
    ["user's id isn't set (42)", "user's id isn't set (<n>)"],
    // Words made of hex letters stay; a long number is a number, not a hex id.
    ["deadbeef cafe faded", "deadbeef cafe faded"],
    ["id 123456789012", "id <n>"],
    // A quoted string holding a number is one placeholder.
    [`Cannot read 'id' of "user 12"`, "Cannot read <str> of <str>"],
    ["timeout after 250ms (utf8, id42)", "timeout after <n>ms (utf8, id42)"],
    ["  spaced \n\t out  ", "spaced out"],
    ["", ""],
  ])("%j -> %j", (input, expected) => {
    expect(normaliseMessage(input)).toBe(expected);
  });

  it("is stable on its own output and bounds the length", () => {
    const once = normaliseMessage("user 42 <n> 'x'");
    expect(normaliseMessage(once)).toBe(once);
    expect(normaliseMessage("word ".repeat(500)).length).toBeLessThanOrEqual(
      303,
    );
  });

  it("does not backtrack catastrophically on an unclosed quote", () => {
    const start = Date.now();
    normaliseMessage(`"${"a ".repeat(50_000)}`);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

const NOW = Date.UTC(2026, 10, 12, 12, 0, 30);
const MIN = 60_000;
const occ = (
  n: number,
  minutesAgo: number,
  rest: Partial<ErrorOccurrence> = {},
): ErrorOccurrence => ({
  traceId: n.toString(16).padStart(32, "0"),
  spanId: n.toString(16).padStart(16, "0"),
  timeUnixMs: NOW - minutesAgo * MIN,
  errorType: "NotFoundException",
  message: `user ${n} not found`,
  route: "/users/:id",
  service: "api",
  ...rest,
});

describe("groupErrors", () => {
  it("groups by type, normalised message and route", () => {
    const r = groupErrors(
      [
        occ(1, 1),
        occ(2, 3),
        occ(3, 2, { route: "/other" }),
        occ(4, 2, { errorType: "TimeoutError" }),
        occ(5, 2, { message: "boom" }),
        occ(6, 2, { route: undefined }),
      ],
      15,
      NOW,
    );
    expect(r.groups).toHaveLength(5);
    const top = r.groups[0];
    expect(top).toMatchObject({
      errorType: "NotFoundException",
      pattern: "user <n> not found",
      route: "/users/:id",
      count: 2,
      firstSeenUnixMs: NOW - 3 * MIN,
      lastSeenUnixMs: NOW - 1 * MIN,
      services: ["api"],
      exampleTraceId: occ(1, 1).traceId,
      latestMessage: "user 1 not found",
    });
    expect(r.groups.slice(1).every((g) => g.count === 1)).toBe(true);
    expect(r.groups.find((g) => g.route === undefined)).toBeDefined();
  });

  it("buckets per minute for 15 minutes and per five minutes for 60", () => {
    const items = [occ(1, 0), occ(2, 0), occ(3, 14), occ(4, 20)];
    const short = groupErrors(items, 15, NOW);
    expect(short.bucketMs).toBe(MIN);
    expect(short.fromUnixMs).toBe(NOW - (NOW % MIN) - 14 * MIN);
    const g = short.groups[0];
    expect(g?.series).toHaveLength(15);
    expect(g?.series[14]).toBe(2);
    expect(g?.series[0]).toBe(1);
    expect(g?.count).toBe(3); // the 20-minute-old one is outside
    expect(g?.series.reduce((a, b) => a + b, 0)).toBe(3);

    const long = groupErrors(items, 60, NOW);
    expect(long.bucketMs).toBe(5 * MIN);
    expect(long.groups[0]?.series).toHaveLength(12);
    expect(long.groups[0]?.count).toBe(4);
    expect(long.groups[0]?.series.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("keeps the newest ten occurrences newest first, and the latest as the example", () => {
    const items = Array.from({ length: 80 }, (_, i) => occ(i + 1, 10 - i / 10));
    const g = groupErrors(items, 15, NOW).groups[0];
    expect(g?.count).toBe(80);
    expect(g?.recent).toHaveLength(10);
    expect(g?.recent.map((o) => o.traceId)).toEqual(
      items
        .slice(-10)
        .reverse()
        .map((o) => o.traceId),
    );
    expect(g?.exampleTraceId).toBe(items[79]?.traceId);
  });

  it("collects services, orders by count then recency, and survives no input", () => {
    const r = groupErrors(
      [
        occ(1, 5, { service: "b" }),
        occ(2, 4, { service: "a" }),
        occ(3, 1, { message: "x" }),
        occ(4, 2, { message: "y" }),
      ],
      15,
      NOW,
    );
    expect(r.groups[0]?.services).toEqual(["a", "b"]);
    expect(r.groups.map((g) => g.pattern)).toEqual([
      "user <n> not found",
      "x",
      "y",
    ]);
    expect(groupErrors([], 15, NOW).groups).toEqual([]);
  });
});
