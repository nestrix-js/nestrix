// The fixture app's GET /out (fetch and http.get from a Nest handler) produces two client spans and
// sends traceparent. Global state: @nestrix-js/testing's host provider, plus the ALS context manager
// and W3C propagator registered here. P1-06's server span is not used: a middleware starts an
// active request span as a stand-in parent.

import { type BootedApp, bootApp } from "@nestrix-js/testing";
import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installOutbound } from "../src/outbound/index.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import {
  type EchoServer,
  resolved,
  startEchoServer,
} from "./outbound-helpers.js";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

let echo: EchoServer;
let booted: BootedApp;
let uninstall: () => void;
const diagnostics = recordingDiagnostics();

beforeAll(async () => {
  echo = await startEchoServer();
  process.env.OUT_URL = `${echo.base}/ok`;
  uninstall = installOutbound(resolved(), diagnostics);
  booted = await bootApp("express", {
    configure: (app) => {
      app.use(
        (
          _req: unknown,
          res: { on(e: string, f: () => void): void },
          next: () => void,
        ) => {
          const span = trace.getTracer("test").startSpan("request");
          res.on("finish", () => span.end());
          context.with(trace.setSpan(context.active(), span), next);
        },
      );
    },
  });
});
afterAll(async () => {
  uninstall();
  await booted.close();
  await echo.close();
  delete process.env.OUT_URL;
});

describe("GET /out in the fixture app", () => {
  it("gives a client span per outgoing call, children of the request span, each sending its traceparent", async () => {
    const res = await fetch(`${booted.baseUrl}/out`);
    expect(await res.json()).toEqual({ fetch: 200, http: 200 });
    const request = await booted.waitForSpan("request");
    const clients = booted
      .spans()
      .filter((s) => s.instrumentationScope.name === "@nestrix-js/nestjs");
    expect(clients).toHaveLength(2);
    for (const span of clients) {
      expect(span.name).toBe("GET");
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
      expect(span.attributes["url.full"]).toBe(`${echo.base}/ok`);
    }
    const sent = echo.received.map((r) => r.traceparent);
    expect(sent).toHaveLength(2);
    const sentSpanIds = sent.map((t) => t[0]?.split("-")[2]).sort();
    expect(sentSpanIds).toEqual(
      clients.map((s) => s.spanContext().spanId).sort(),
    );
    expect(diagnostics.failures).toEqual([]);
  });
});
