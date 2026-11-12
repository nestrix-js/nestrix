import type { TraceLogRecord } from "@nestrix-js/protocol";

/** OTLP severity ranges (1-4 trace ... 21-24 fatal); 0 or out of range is `unknown`. */
export type LogTone =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"
  | "unknown";

const TONES: LogTone[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export function logTone(severity: number): LogTone {
  if (!Number.isInteger(severity) || severity < 1 || severity > 24)
    return "unknown";
  return TONES[Math.floor((severity - 1) / 4)] ?? "unknown";
}

/** What the level column shows: the level as written, else the severity range's name. */
export function logLevelLabel(record: TraceLogRecord): string {
  const level = record.level.trim();
  if (level !== "") return level.toLowerCase();
  const tone = logTone(record.severity);
  return tone === "unknown" ? "-" : tone;
}

/** Text colour of a line's level by severity: errors red, warnings amber, debug and trace muted. */
export function toneClass(tone: LogTone): string {
  switch (tone) {
    case "error":
    case "fatal":
      return "text-destructive";
    case "warn":
      return "text-warning";
    case "trace":
    case "debug":
    case "unknown":
      return "text-muted-foreground";
    default:
      return "";
  }
}

export interface SpanLogSummary {
  count: number;
  /** The highest severity among the span's lines. */
  maxSeverity: number;
  /** The span's lines, in the order given (time order). */
  lines: TraceLogRecord[];
}

/** Lines per span id, for the markers on the waterfall rows. Lines without a span are left out. */
export function logsBySpan(
  logs: readonly TraceLogRecord[],
): Map<string, SpanLogSummary> {
  const out = new Map<string, SpanLogSummary>();
  for (const line of logs) {
    if (line.spanId === undefined) continue;
    const s = out.get(line.spanId);
    if (s === undefined)
      out.set(line.spanId, {
        count: 1,
        maxSeverity: line.severity,
        lines: [line],
      });
    else {
      s.count++;
      s.lines.push(line);
      if (line.severity > s.maxSeverity) s.maxSeverity = line.severity;
    }
  }
  return out;
}

/** Offset of a line from the trace's start, for the time column ("+12.4 ms"). */
export function logOffsetMs(
  line: TraceLogRecord,
  traceStartMs: number,
): number {
  return line.timeUnixMs - traceStartMs;
}
