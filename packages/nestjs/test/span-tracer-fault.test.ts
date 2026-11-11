import { type Tracer, type TracerProvider, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { Span, withSpan } from "../src/span.js";

type Mode =
  | "returns-silently"
  | "throws-before"
  | "throws-after"
  | "get-tracer-throws";
let mode: Mode = "throws-before";

const tracer = {
  startSpan() {
    throw new Error("tracer broken");
  },
  startActiveSpan(...args: unknown[]) {
    if (mode === "returns-silently") return undefined;
    if (mode === "throws-before") throw new Error("tracer broken");
    const fn = args[args.length - 1] as (span: unknown) => unknown;
    fn(
      trace.wrapSpanContext({
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        traceFlags: 1,
      }),
    );
    throw new Error("tracer broken after callback");
  },
} as unknown as Tracer;

const provider: TracerProvider = {
  getTracer() {
    if (mode === "get-tracer-throws") throw new Error("getTracer broken");
    return tracer;
  },
};
trace.setGlobalTracerProvider(provider);

describe("a failing tracer never changes what the user's function does", () => {
  for (const m of [
    "throws-before",
    "get-tracer-throws",
    "returns-silently",
  ] as const) {
    it(`${m}: runs fn once and returns its value`, () => {
      mode = m;
      let calls = 0;
      expect(
        withSpan("x", (span) => {
          calls++;
          expect(span).toBeDefined();
          return "ok";
        }),
      ).toBe("ok");
      expect(calls).toBe(1);
    });

    it(`${m}: runs fn once and rethrows its error`, () => {
      mode = m;
      let calls = 0;
      const boom = new Error("user");
      try {
        withSpan("x", () => {
          calls++;
          throw boom;
        });
        expect.unreachable();
      } catch (e) {
        expect(e).toBe(boom);
      }
      expect(calls).toBe(1);
    });
  }

  it("a tracer that throws after calling back neither re-runs fn nor swallows its result", () => {
    mode = "throws-after";
    let calls = 0;
    expect(withSpan("x", () => ++calls)).toBe(1);
    expect(calls).toBe(1);
    const boom = new Error("user");
    expect(() =>
      withSpan("x", () => {
        calls++;
        throw boom;
      }),
    ).toThrow(boom);
    expect(calls).toBe(2);
  });

  it("@Span keeps working when the tracer is broken", async () => {
    mode = "throws-before";
    class C {
      @Span()
      async m(n: number) {
        return n * 2;
      }
    }
    await expect(new C().m(4)).resolves.toBe(8);
  });
});
