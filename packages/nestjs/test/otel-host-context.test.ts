// Global state: the host registered only a context manager (a sync-only
// StackContextManager), no provider and no propagator. Nestrix owns the provider,
// keeps the host's context manager, registers the propagator, and warns that context
// does not survive `await`.
import {
  type ContextManager,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";
import { StackContextManager } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { setupTelemetry } from "../src/otel/setup.js";
import { config, recordingDiagnostics } from "./otel-helpers.js";

const stack = new StackContextManager().enable();
let hostWithCalls = 0;
const hostManager: ContextManager = {
  active: () => stack.active(),
  with(ctx, fn, thisArg, ...args) {
    hostWithCalls++;
    return stack.with(ctx, fn, thisArg, ...args);
  },
  bind: (ctx, target) => stack.bind(ctx, target),
  enable() {
    stack.enable();
    return hostManager;
  },
  disable() {
    stack.disable();
    return hostManager;
  },
};

describe("host context manager present, no host provider", () => {
  it("Nestrix owns the provider but does not replace the host's context manager", async () => {
    expect(context.setGlobalContextManager(hostManager)).toBe(true);
    const diagnostics = recordingDiagnostics();
    const handle = setupTelemetry(config(), diagnostics);
    expect(handle.ownsProvider).toBe(true);
    expect(handle.registered).toEqual({
      tracerProvider: true,
      contextManager: false,
      propagator: true,
    });

    const before = hostWithCalls;
    const span = trace.getTracer("t").startSpan("s");
    const seen = context.with(
      trace.setSpan(context.active(), span),
      () => trace.getActiveSpan()?.spanContext().spanId,
    );
    span.end();
    expect(seen).toBe(span.spanContext().spanId);
    expect(hostWithCalls).toBe(before + 1);
    expect(propagation.fields()).toEqual(["traceparent", "tracestate"]);

    // The async probe runs after setup returns; give it a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(diagnostics.logs.get("otel.context-sync-only")).toMatch(
      /across await/,
    );
    expect(diagnostics.failures).toEqual([]);

    await handle.shutdown();
    // Shutdown removes only what Nestrix registered: the host's manager stays.
    const after = hostWithCalls;
    context.with(context.active(), () => undefined);
    expect(hostWithCalls).toBe(after + 1);
    expect(propagation.fields()).toEqual([]);
  });
});
