import { describe, expect, it } from "vitest";

import { formatClockTime, formatZone } from "@/lib/clock-time";

describe("clock time", () => {
  it("formats local time on a 24 hour clock with milliseconds", () => {
    const d = new Date(2026, 10, 11, 20, 26, 40, 123);
    expect(formatClockTime(d.getTime())).toBe("2026-11-11 20:26:40.123");
    const early = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(formatClockTime(early.getTime())).toBe("2026-01-02 03:04:05.006");
  });

  it("names the local offset", () => {
    const d = new Date(2026, 10, 11, 12, 0, 0);
    const offset = -d.getTimezoneOffset();
    const expected =
      offset === 0
        ? "UTC"
        : `UTC${offset < 0 ? "-" : "+"}${Math.floor(Math.abs(offset) / 60)}${
            Math.abs(offset) % 60 === 0
              ? ""
              : `:${String(Math.abs(offset) % 60).padStart(2, "0")}`
          }`;
    expect(formatZone(d.getTime())).toBe(expected);
  });
});
