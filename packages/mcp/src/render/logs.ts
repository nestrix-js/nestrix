import type { LogSearchResponse } from "@nestrix-js/protocol";
import { clean, fmtTime } from "./format.js";

/** One line per log line, newest first: time, level, service, trace, message. */
export function renderLogs(res: LogSearchResponse, filters: string): string {
  const out: string[] = [];
  out.push(
    `${res.items.length} log line${res.items.length === 1 ? "" : "s"}${filters ? ` (${filters})` : ""}, newest first. The server stores ${
      res.capture === "all"
        ? "every log line it receives (NESTRIX_LOGS=all)"
        : "only lines that carry a trace id (NESTRIX_LOGS=trace, the default)"
    }.`,
  );
  for (const item of res.items) {
    const level = clean(item.level, 16) || `sev${item.severity}`;
    const trace =
      item.traceId === undefined
        ? ""
        : ` trace=${item.traceId}${item.traceExists === false ? " (not stored)" : ""}`;
    const cut = item.truncated ? " [message cut to 8192 characters]" : "";
    out.push(
      `${fmtTime(item.timeUnixMs)} ${level} ${clean(item.service, 80)}${item.context ? ` [${clean(item.context, 60)}]` : ""}${trace}: ${clean(item.message, 500)}${cut}`,
    );
  }
  if (res.items.length === 0) out.push("No log lines match.");
  if (res.dropped.total > 0) {
    out.push(
      `${res.dropped.total} lines were not stored on these days: ${res.dropped.rateCap} over the per-minute budget, ${res.dropped.traceCap} over the per-trace maximum, ${res.dropped.outOfRange} outside the retention.`,
    );
  }
  if (res.older !== null) {
    out.push(`More lines: call again with before=${res.older}`);
  }
  return out.join("\n");
}
