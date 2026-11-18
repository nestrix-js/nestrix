// The error-occurrence rules (D-93, D-94). The same cases as the embedded copy
// (`packages/nestjs/test/error-facts-unit.test.ts`).
import { describe, expect, it } from "vitest";
import {
  isErrorOccurrence,
  isFailedSpan,
  primaryException,
  sameException,
} from "../../src/storage/error-facts.js";

const ex = (message: string, marks: Record<string, unknown> = {}) => ({
  name: "exception",
  attributes: { "exception.message": message, ...marks },
});
const PROPAGATED = { "nestrix.exception.propagated": true };
const EXPECTED = { "nestrix.exception.expected": "true" };

describe("error facts", () => {
  it("primary: the first exception neither propagated nor expected", () => {
    expect(
      primaryException([
        {
          name: "log",
          attributes: { "exception.message": "not an exception" },
        },
        ex("a", PROPAGATED),
        ex("b", EXPECTED),
        ex("c"),
        ex("d"),
      ])?.attributes["exception.message"],
    ).toBe("c");
    expect(primaryException([ex("a", PROPAGATED)])).toBeUndefined();
  });

  it("occurrence: error status, and no exception or a primary one", () => {
    expect(isErrorOccurrence("error", [])).toBe(true);
    expect(isErrorOccurrence("error", [ex("a")])).toBe(true);
    expect(isErrorOccurrence("error", [ex("a", PROPAGATED)])).toBe(false);
    expect(isErrorOccurrence("error", [ex("a", EXPECTED)])).toBe(false);
    expect(isErrorOccurrence("unset", [ex("a")])).toBe(false);
    expect(isErrorOccurrence("ok", [])).toBe(false);
  });

  it("failed: error status unless every exception is expected", () => {
    expect(isFailedSpan("error", [])).toBe(true);
    expect(isFailedSpan("error", [ex("a", PROPAGATED)])).toBe(true);
    expect(isFailedSpan("error", [ex("a", EXPECTED)])).toBe(false);
    expect(isFailedSpan("error", [ex("a", EXPECTED), ex("b")])).toBe(true);
    expect(isFailedSpan("unset", [ex("a")])).toBe(false);
  });

  it("same exception: type, message and stack trace", () => {
    const a = {
      name: "exception",
      attributes: {
        "exception.type": "Error",
        "exception.message": "x",
        "exception.stacktrace": "s",
      },
    };
    expect(sameException(a, { ...a, attributes: { ...a.attributes } })).toBe(
      true,
    );
    expect(
      sameException(a, {
        ...a,
        attributes: { ...a.attributes, "exception.stacktrace": "t" },
      }),
    ).toBe(false);
  });
});
