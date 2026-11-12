import type { TraceLogRecord } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  logLevelLabel,
  logsBySpan,
  logTone,
  toneClass,
} from "@/lib/trace-logs";

const line = (over: Partial<TraceLogRecord>): TraceLogRecord => ({
  timeUnixMs: 0,
  severity: 9,
  level: "log",
  message: "m",
  ...over,
});

describe("trace logs helpers", () => {
  it("maps OTLP severity ranges to tones", () => {
    expect([0, 1, 4, 5, 9, 13, 17, 21, 24, 25, 9.5].map(logTone)).toEqual([
      "unknown",
      "trace",
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
      "fatal",
      "unknown",
      "unknown",
    ]);
    expect(toneClass("error")).toBe("text-destructive");
    expect(toneClass("warn")).toBe("text-warning");
    expect(toneClass("info")).toBe("");
  });

  it("labels a line by its level, else by its severity", () => {
    expect(logLevelLabel(line({ level: "WARN" }))).toBe("warn");
    expect(logLevelLabel(line({ level: "", severity: 17 }))).toBe("error");
    expect(logLevelLabel(line({ level: " ", severity: 0 }))).toBe("-");
  });

  it("summarises lines per span, ignoring lines without a span", () => {
    const a1 = line({ spanId: "a", severity: 9 });
    const a2 = line({ spanId: "a", severity: 17 });
    const b = line({ spanId: "b", severity: 5 });
    const m = logsBySpan([a1, a2, b, line({})]);
    expect(Object.fromEntries(m)).toEqual({
      a: { count: 2, maxSeverity: 17, lines: [a1, a2] },
      b: { count: 1, maxSeverity: 5, lines: [b] },
    });
  });
});
