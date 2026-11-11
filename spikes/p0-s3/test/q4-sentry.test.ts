import { describe, expect, it } from "vitest";
import { runSentry, type SentryRun, summarize } from "./sentry-run.ts";

const INCOMING_TRACE = "0af7651916cd43dd8448eb211c80319c";
const TRACEPARENT = `00-${INCOMING_TRACE}-b7ad6b7169203331-01`;

const traceOf = (tp: unknown) => String(tp).split("-")[1];
const sentryTraceOf = (st: unknown) => String(st).split("-")[0];
const otelTraceOf = (r: SentryRun, name: string) => {
  const s = r.nestrixSpans.find((x) => x.name === name);
  if (!s) throw new Error(`no OTel span ${name}`);
  return s.traceId;
};
const sentrySpans = (r: SentryRun) =>
  r.items
    .filter((i) => i.type === "span")
    .flatMap((i) => i.payload?.items ?? [i.payload]);
const events = (r: SentryRun) => r.items.filter((i) => i.type === "event");
const log = (r: SentryRun) =>
  console.log(
    `[Q4 ${r.mode} node ${r.result.node}]`,
    JSON.stringify(summarize(r)),
  );

/** Sentry's default http integration still adds sentry-trace; Nestrix adds traceparent. */
function expectConflictingOutbound(r: SentryRun) {
  expect(r.outbound.map((o) => o.client).sort()).toEqual(["fetch", "http"]);
  const outTrace = otelTraceOf(r, "GET /out");
  for (const o of r.outbound) {
    expect(traceOf(o.headers.traceparent)).toBe(outTrace);
    expect(o.headers["sentry-trace"]).toBeDefined();
    expect(sentryTraceOf(o.headers["sentry-trace"])).not.toBe(outTrace);
  }
}

describe("Q4: @sentry/nestjs 11 alongside Nestrix (Express)", () => {
  it("default settings (no tracesSampleRate): Nestrix owns OTel; error event is on another trace", async () => {
    const r = await runSentry("default", { boom: true });
    log(r);
    expect(r.result.nestrix).toMatchObject({
      providerRegistered: true,
      contextManagerRegistered: true,
      propagatorRegistered: true,
    });
    expect(sentrySpans(r)).toEqual([]);
    expect(events(r)).toHaveLength(1);
    expect(events(r)[0].payload.contexts.trace.trace_id).not.toBe(
      otelTraceOf(r, "GET /boom"),
    );
    expectConflictingOutbound(r);
  });

  it("tracesSampleRate: 1: two traces per request, two conflicting headers out", async () => {
    const r = await runSentry("default-traces", { boom: true });
    log(r);
    const sentryServer = sentrySpans(r).find(
      (s) => s.name === "GET /out" && s.parent_span_id === undefined,
    );
    expect(sentryServer).toBeDefined();
    expect(sentryServer.trace_id).not.toBe(otelTraceOf(r, "GET /out"));
    expectConflictingOutbound(r);
    for (const o of r.outbound) {
      expect(sentryTraceOf(o.headers["sentry-trace"])).toBe(
        sentryServer.trace_id,
      );
    }
  });

  it("Sentry's envelope POSTs: the no-parent rule skips the background ones, not the one sent inside a request", async () => {
    const r = await runSentry("default-traces", { boom: true });
    const posts = r.nestrixSpans.filter((s) => s.name === "POST");
    const envelopeHeaders = r.items.map(
      (i) => i.requestHeaders.traceparent ?? "none",
    );
    console.log(
      "[Q4 transport] POST spans",
      JSON.stringify(posts.map((p) => ({ root: !p.parentSpanId }))),
      "skips",
      JSON.stringify(r.result.httpSkips),
      "traceparent on envelope requests",
      JSON.stringify(envelopeHeaders),
    );
    // Sentry's transport does not set OpenTelemetry's suppress-tracing key.
    expect(r.result.httpSkips.suppressed).toBe(0);
    // Envelopes sent with no active span: no client span, no header.
    expect(r.result.httpSkips.noParent).toBeGreaterThan(0);
    expect(posts.every((p) => p.parentSpanId)).toBe(true);
    // The error envelope is sent from inside GET /boom: still traced, still carries
    // traceparent to the third party. Only a host ignore list would stop it.
    const boom = r.nestrixSpans.find((s) => s.name === "GET /boom");
    expect(posts).toHaveLength(1);
    expect(posts[0].parentSpanId).toBe(boom?.spanId);
    expect(envelopeHeaders.filter((h) => h !== "none")).toHaveLength(1);
  });

  it("rule 1: the route hook renames only Nestrix's own span (otel-setup, hook on vs off)", async () => {
    const names = async (fault?: string, legacyRoute = false) => {
      const r = await runSentry("otel-setup", { fault, legacyRoute });
      return sentrySpans(r)
        .filter(
          (s) => s.attributes?.["sentry.origin"]?.value === "auto.http.express",
        )
        .map((s) => s.name)
        .sort();
    };
    const on = await names();
    const off = await names("route-hook");
    console.log(
      "[Q4 route hook] express spans on:",
      JSON.stringify(on),
      "off:",
      JSON.stringify(off),
    );
    expect(on).toContain("/out");
    expect(on).toEqual(off);
    // Control: the pre-review hook (renames trace.getActiveSpan()) renames Sentry's
    // Express handler span, so this test does catch the regression.
    const legacy = await names(undefined, true);
    console.log(
      "[Q4 route hook] express spans, legacy hook:",
      JSON.stringify(legacy),
    );
    expect(legacy).toContain("GET /out");
    expect(legacy).not.toContain("/out");
  });

  it("an incoming traceparent is continued by Nestrix, not by Sentry", async () => {
    const r = await runSentry("default-traces", { traceparent: TRACEPARENT });
    log(r);
    expect(otelTraceOf(r, "GET /out")).toBe(INCOMING_TRACE);
    const sentryServer = sentrySpans(r).find(
      (s) => s.name === "GET /out" && s.parent_span_id === undefined,
    );
    expect(sentryServer.trace_id).not.toBe(INCOMING_TRACE);
  });

  it("documented custom setup (host OTel first + openTelemetryIntegration()): still two traces", async () => {
    const r = await runSentry("custom", { boom: true });
    log(r);
    expect(r.result.nestrix).toMatchObject({
      providerRegistered: false,
      contextManagerDetected: true,
      propagatorDetected: true,
    });
    expect(r.result.hostRegistered).toEqual({
      provider: true,
      contextManager: true,
      propagator: true,
    });
    // Sentry's scope does take the OTel span's ids...
    expect(r.probe.hasExternalPropagationContext).toBe(true);
    expect(r.probe.sentryTraceContext.trace_id).toBe(
      r.probe.otelActive.traceId,
    );
    // ...but a non-recording Sentry span from its default integrations is active and
    // takes precedence, for the error event and for the outgoing sentry-trace.
    expect(r.probe.sentryActiveSpan.traceFlags).toBe(0);
    expect(r.probe.sentryActiveSpan.traceId).not.toBe(
      r.probe.otelActive.traceId,
    );
    expect(events(r)).toHaveLength(1);
    expect(events(r)[0].payload.contexts.trace.trace_id).not.toBe(
      otelTraceOf(r, "GET /boom"),
    );
    expectConflictingOutbound(r);
  });

  it("custom setup with tracesSampleRate: 1: Sentry spans on their own traces", async () => {
    const r = await runSentry("custom-traces", { boom: true });
    log(r);
    const otelTraces = new Set(r.nestrixSpans.map((s) => s.traceId));
    for (const s of sentrySpans(r))
      expect(otelTraces.has(s.trace_id)).toBe(false);
    expectConflictingOutbound(r);
  });

  it("diagnosis: custom setup with defaultIntegrations: false is one trace", async () => {
    const r = await runSentry("custom-bare", { boom: true });
    log(r);
    expect(r.probe.sentryActiveSpan).toBeNull();
    expect(events(r)).toHaveLength(1);
    expect(events(r)[0].payload.contexts.trace.trace_id).toBe(
      otelTraceOf(r, "GET /boom"),
    );
    for (const o of r.outbound) {
      expect(traceOf(o.headers.traceparent)).toBe(otelTraceOf(r, "GET /out"));
      expect(o.headers["sentry-trace"]).toBeUndefined();
    }
  });

  it("enableOpenTelemetrySetup: true: one trace, but Nestrix is a passenger", async () => {
    const r = await runSentry("otel-setup", { boom: true });
    log(r);
    expect(r.result.nestrix).toMatchObject({
      providerRegistered: false,
      contextManagerDetected: true,
      propagatorDetected: true,
      propagatorFields: ["sentry-trace", "baggage", "traceparent"],
    });
    // Nestrix's own provider lost, and nothing feeds its store.
    expect(r.result.nestrixOwnStore).toEqual([]);
    // Nestrix's spans are in Sentry's trace for the request...
    const spans = sentrySpans(r);
    const server = spans.find(
      (s) => s.name === "GET /out" && s.parent_span_id === undefined,
    );
    const manual = spans.filter(
      (s) =>
        s.trace_id === server.trace_id &&
        (s.attributes?.["sentry.origin"]?.value ?? s.origin) === "manual",
    );
    console.log(
      "[Q4 otel-setup] manual (Nestrix) spans in Sentry's /out trace:",
      manual.map((s) => s.name).join(", "),
    );
    expect(manual.length).toBeGreaterThanOrEqual(3);
    // ...but Nestrix's context does not survive Sentry's Express instrumentation: its
    // server span is a child of Sentry's middleware span, its client spans are children
    // of Sentry's "Request handler", and the route hook never finds Nestrix's own
    // request state, so the server span keeps the name "GET" and the route is lost
    // from Nestrix's statistics too.
    const nestrixServer = manual.filter(
      (s) => (s.kind ?? s.attributes?.["sentry.kind"]?.value) === "server",
    );
    expect(nestrixServer).toHaveLength(1);
    expect(nestrixServer[0].name).toBe("GET");
    expect(r.result.routeStats).toEqual({ GET: 3 }); // /out, /boom, /s3/probe
    // No traceparent goes out: SentryPropagator refuses a context other than the
    // active one.
    for (const o of r.outbound) {
      expect(o.headers.traceparent).toBeUndefined();
      expect(sentryTraceOf(o.headers["sentry-trace"])).toBe(server.trace_id);
    }
    expect(r.stderr).toMatch(
      /SentryPropagator: Injecting trace data of a different context than the active one is not supported/,
    );
    expect(events(r)[0].payload.contexts.trace.trace_id).toBe(
      spans.find(
        (s) => s.name === "GET /boom" && s.parent_span_id === undefined,
      ).trace_id,
    );
  });
});
