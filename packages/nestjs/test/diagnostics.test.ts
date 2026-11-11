import { Logger } from "@nestjs/common";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  diagnostics,
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";

let log: MockInstance<Logger["log"]>;

beforeEach(() => {
  resetDiagnosticsForTests();
  log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logOnce", () => {
  it("writes once per key and again for a different key", () => {
    diagnostics.logOnce("a", "first");
    diagnostics.logOnce("a", "second");
    diagnostics.logOnce("b", "third");
    expect(log.mock.calls.map((c) => c[0])).toEqual(["first", "third"]);
  });

  it("logs through Nest's Logger with the context Nestrix", () => {
    const seen: (string | undefined)[] = [];
    log.mockImplementation(function (this: Logger) {
      // `context` is a protected field of Nest's Logger.
      seen.push((this as unknown as { context?: string }).context);
    });
    diagnostics.logOnce("ctx", "hello");
    expect(seen).toEqual(["Nestrix"]);
  });

  it("never throws when the logger does, and does not retry that key", () => {
    log.mockImplementation(() => {
      throw new Error("logger down");
    });
    expect(() => diagnostics.logOnce("boom", "x")).not.toThrow();
    log.mockImplementation(() => undefined);
    diagnostics.logOnce("boom", "x");
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("countFailure", () => {
  it("counts per site and logs only the first error of each site", () => {
    diagnostics.countFailure("site.a", new Error("one"));
    diagnostics.countFailure("site.a", new Error("two"));
    diagnostics.countFailure("site.a", new Error("three"));
    diagnostics.countFailure("site.b", "plain string");
    expect(Object.fromEntries(getFailureCounts())).toEqual({
      "site.a": 3,
      "site.b": 1,
    });
    const messages = log.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('"site.a"');
    expect(messages[0]).toContain("one");
    expect(messages.join("\n")).not.toContain("two");
    expect(messages[1]).toContain("plain string");
  });

  it("never throws, even for errors that cannot be described", () => {
    const hostile = {
      toString() {
        throw new Error("no string for you");
      },
    };
    expect(() => diagnostics.countFailure("hostile", hostile)).not.toThrow();
    expect(() => diagnostics.countFailure("nullish", undefined)).not.toThrow();
    expect(getFailureCounts().get("hostile")).toBe(1);
  });

  it("never throws when the logger does, and still counts", () => {
    log.mockImplementation(() => {
      throw new Error("logger down");
    });
    expect(() => diagnostics.countFailure("x", new Error("e"))).not.toThrow();
    expect(() => diagnostics.countFailure("x", new Error("e"))).not.toThrow();
    expect(getFailureCounts().get("x")).toBe(2);
  });

  it("getFailureCounts returns a copy", () => {
    diagnostics.countFailure("copy", new Error("e"));
    const snapshot = getFailureCounts() as Map<string, number>;
    snapshot.set("copy", 99);
    expect(getFailureCounts().get("copy")).toBe(1);
  });
});
