// Review fixes for P8-02: the access value never reaches tool output, get_trace stays bounded on
// deep or cyclic traces, and telemetry text cannot break out of its line.
import type { TraceResponse } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";
import { NestrixClient } from "../src/client.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { MAX_OUTPUT_CHARS, renderTrace } from "../src/render/trace.js";
import { TELEMETRY_NOTE } from "../src/tools.js";
import { span, traceId } from "./fixtures.js";

const BASE = "http://127.0.0.1:1/_nestrix";
const VALUE = "q".repeat(40);

describe("the configured access value", () => {
  it("is refused at startup when it holds control characters or spaces, without echoing it", () => {
    for (const bad of [`${VALUE}\r\nline2`, `${VALUE} x`, `${VALUE}\tx`]) {
      let error: unknown;
      try {
        loadConfig({ NESTRIX_URL: BASE, NESTRIX_TOKEN: bad });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect(String((error as Error).message)).not.toContain(VALUE);
    }
  });

  it("never appears in a network error message", async () => {
    const config = loadConfig({ NESTRIX_URL: BASE, NESTRIX_TOKEN: VALUE });
    const client = new NestrixClient(config);
    let message = "";
    try {
      await client.meta();
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(VALUE);
  });
});

function chain(depth: number, errorAtLeaf: boolean): TraceResponse {
  const spans = [span(1, undefined, "GET /deep", 0, depth + 10)];
  for (let n = 2; n <= depth; n++) {
    spans.push(
      span(
        n,
        n - 1,
        "Recursive.step",
        n * 0.001,
        depth - n + 5,
        {},
        n === depth && errorAtLeaf
          ? { status: { code: "error", message: "leaf failed" } }
          : {},
      ),
    );
  }
  return {
    traceId: traceId(9),
    rootSpanId: spans[0]?.spanId ?? "",
    resource: {},
    spans,
  };
}

describe("get_trace stays bounded", () => {
  it("a 2,500-deep chain with an error at the leaf, at maxSpans 10, is small and still shows the error", () => {
    const text = renderTrace(chain(2500, true), { maxSpans: 10 });
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain("leaf failed");
  });

  it("a 6,000-deep chain renders without overflowing the stack", () => {
    const text = renderTrace(chain(6000, false));
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 500);
  });

  it("a cycle through duplicate span ids terminates", () => {
    const a = span(1, undefined, "GET /loop", 0, 10);
    const x = span(2, 3, "X", 1, 5);
    const y = span(3, 2, "Y", 2, 4);
    const xAgain = span(2, 3, "X again", 3, 2);
    const trace: TraceResponse = {
      traceId: traceId(8),
      rootSpanId: a.spanId,
      resource: {},
      spans: [a, x, y, xAgain],
    };
    expect(() => renderTrace(trace)).not.toThrow();
  });
});

describe("telemetry text cannot break out of its line", () => {
  it("a span name with line breaks stays on one line in every section", () => {
    const multiLine = "x\n\nSECOND LINE FROM TELEMETRY\nthird";
    const root = span(1, undefined, multiLine, 0, 300);
    const child = span(
      2,
      1,
      multiLine,
      1,
      250,
      {},
      { status: { code: "error", message: `boom\n${multiLine}` } },
    );
    const trace: TraceResponse = {
      traceId: traceId(7),
      rootSpanId: root.spanId,
      resource: { "service.name": `svc\n${multiLine}` },
      spans: [root, child],
    };
    for (const line of renderTrace(trace).split("\n")) {
      expect(line.startsWith("SECOND LINE FROM TELEMETRY")).toBe(false);
      expect(line.startsWith("third")).toBe(false);
    }
  });

  it("results that carry telemetry say it is data, not instructions", () => {
    expect(TELEMETRY_NOTE).toMatch(/not instructions/i);
  });
});
