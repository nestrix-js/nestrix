import { traceListParams } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  isRequestListLink,
  numberParser,
  requestFilterParsers,
  serviceParser,
  stringParser,
} from "@/lib/params";

describe("parsers built from the protocol specs", () => {
  it("accepts a number inside the spec's bounds and rejects the rest", () => {
    const p = requestFilterParsers.minDurationMs;
    expect(p.parse("250")).toBe(250);
    expect(p.parse("0.5")).toBe(0.5);
    expect(p.parse("-1")).toBeNull();
    expect(p.parse(String(traceListParams.minDurationMs.max + 1))).toBeNull();
    expect(p.parse("abc")).toBeNull();
    expect(p.parse("")).toBeNull();
    expect(p.serialize(250)).toBe("250");
  });

  it("an integer parser honours oneOf", () => {
    const p = numberParser({
      min: 15,
      max: 60,
      oneOf: [15, 60],
      integer: true,
    });
    expect(p.parse("15")).toBe(15);
    expect(p.parse("30")).toBeNull();
    expect(p.parse("15.5")).toBeNull();
  });

  it("a string parser honours maxLength and pattern, and treats empty as unset", () => {
    const p = requestFilterParsers.method;
    expect(p.parse("GET")).toBe("GET");
    expect(
      p.parse("X".repeat(traceListParams.method.maxLength + 1)),
    ).toBeNull();
    expect(p.parse("")).toBeNull();
    const hex = stringParser({ maxLength: 32, pattern: "^[0-9a-f]{32}$" });
    expect(hex.parse("a".repeat(32))).toBe("a".repeat(32));
    expect(hex.parse("A".repeat(32))).toBeNull();
  });

  it("the status parser takes exactly the spec's values", () => {
    const p = requestFilterParsers.status;
    for (const value of traceListParams.status.values)
      expect(p.parse(value)).toBe(value);
    expect(p.parse("warning")).toBeNull();
  });

  it("has a parser for every filter the traces endpoint takes, and none for cursors or limit; the service has its own", () => {
    const filters = Object.keys(traceListParams).filter(
      (k) => !["limit", "before", "after", "service"].includes(k),
    );
    expect(Object.keys(requestFilterParsers).sort()).toEqual(filters.sort());
    expect(Object.keys(traceListParams)).toContain("service");
    expect(serviceParser.parse("orders")).toBe("orders");
    expect(serviceParser.parse("x".repeat(257))).toBeNull();
  });
});

describe("isRequestListLink", () => {
  it("is true for any request-list parameter, whatever its value", () => {
    expect(isRequestListLink({ status: "error" })).toBe(true);
    expect(isRequestListLink({ minDurationMs: 100, windowMinutes: 15 })).toBe(
      true,
    );
    expect(isRequestListLink({ search: "" })).toBe(true);
    expect(isRequestListLink({ fromUnixMs: 1, toUnixMs: 2 })).toBe(true);
  });

  it("is false for the Overview's own parameters and for nothing", () => {
    expect(isRequestListLink({})).toBe(false);
    expect(isRequestListLink({ windowMinutes: 60, service: "orders" })).toBe(
      false,
    );
    expect(isRequestListLink({ unknown: "x" })).toBe(false);
  });
});
