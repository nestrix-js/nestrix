// Generates a large trace for the 5,000-span tests (Playwright, and the unit test of the tree, which loads it by path).
import type { SpanRecord, TraceResponse } from "@nestrix-js/protocol";

/**
 * A trace of `count` spans: one server root, then spans in chains of `fanOut` children per
 * parent, each starting inside its parent. Span names are `span-<n>`; the root is `root`.
 */
export function generateTrace(count: number, fanOut = 4): TraceResponse {
  const t0 = 1_794_400_000_000;
  const id = (n: number) => n.toString(16).padStart(16, "0");
  const spans: SpanRecord[] = [];
  for (let n = 0; n < count; n++) {
    const parent = n === 0 ? undefined : Math.floor((n - 1) / fanOut);
    spans.push({
      spanId: id(n + 1),
      parentSpanId: parent === undefined ? undefined : id(parent + 1),
      name: n === 0 ? "root" : `span-${n}`,
      kind: n === 0 ? "server" : "internal",
      startTimeUnixMs: t0 + n * 0.5,
      durationMs: Math.max(1, (count - n) * 0.25),
      attributes: { "nestrix.index": n },
      events: [],
      status: n % 97 === 0 && n > 0 ? { code: "error" } : { code: "unset" },
      links: [],
    });
  }
  return {
    traceId: "ab".repeat(16),
    rootSpanId: id(1),
    resource: { "service.name": "generated" },
    spans,
  };
}
