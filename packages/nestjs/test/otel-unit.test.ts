// Pure pieces of src/otel and fault injection into every guarded method. Registers no
// OpenTelemetry global (the setup fault is injected before registration; asserted).
import { trace } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { describeForeignRouteHook } from "../src/otel/detect.js";
import {
  batchExportTimeout,
  createDropCountingMeterProvider,
  guardProcessor,
} from "../src/otel/pipeline.js";
import {
  createRedactingExporter,
  settle,
} from "../src/otel/redacting-exporter.js";
import {
  buildResource,
  parseResourceAttributesEnv,
} from "../src/otel/resource.js";
import { setupTelemetry } from "../src/otel/setup.js";
import type { TelemetryConfig } from "../src/otel/types.js";
import { recordingDiagnostics } from "./otel-helpers.js";

function counters() {
  return {
    exportedSpans: 0,
    exportFailedSpans: 0,
    redactDroppedSpans: 0,
    redactFailedSpans: 0,
  };
}

const fakeSpan = {
  name: "n",
  kind: 0,
  spanContext: () => ({
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
  }),
  attributes: { a: "1" },
  events: [],
} as unknown as ReadableSpan;

describe("parseResourceAttributesEnv", () => {
  it("parses and percent-decodes", () => {
    expect(parseResourceAttributesEnv("a=1, b = x%2Cy ,c=%3D")).toEqual({
      a: "1",
      b: "x,y",
      c: "=",
    });
    expect(parseResourceAttributesEnv(undefined)).toEqual({});
    expect(parseResourceAttributesEnv("")).toEqual({});
    expect(parseResourceAttributesEnv("a=1,,")).toEqual({ a: "1" });
  });
  it("discards the whole value on any error", () => {
    expect(parseResourceAttributesEnv("a=1,b")).toBeUndefined();
    expect(parseResourceAttributesEnv("a=1,b=c=d")).toBeUndefined();
    expect(parseResourceAttributesEnv("a=%E0%A4%A")).toBeUndefined();
    expect(parseResourceAttributesEnv("=v")).toBeUndefined();
    expect(parseResourceAttributesEnv(`k=${"x".repeat(256)}`)).toBeUndefined();
  });
  it("buildResource reports a malformed value and keeps the rest", () => {
    let invalid = 0;
    const resource = buildResource(
      {
        serviceName: undefined,
        resourceAttributes: { x: 1 },
        otelResourceAttributes: "bad",
      },
      () => invalid++,
    );
    expect(invalid).toBe(1);
    expect(resource.attributes.x).toBe(1);
    expect(String(resource.attributes["service.name"])).toMatch(
      /^unknown_service/,
    );
  });
});

describe("describeForeignRouteHook", () => {
  const ours = () => {};
  it("finds nothing on non-adapters and empty slots", () => {
    expect(describeForeignRouteHook(undefined)).toBeUndefined();
    expect(describeForeignRouteHook(null)).toBeUndefined();
    expect(describeForeignRouteHook({})).toBeUndefined();
    expect(
      describeForeignRouteHook({ getOnRouteTriggered: () => undefined }),
    ).toBeUndefined();
    expect(
      describeForeignRouteHook({ getOnRouteTriggered: () => ours }, ours),
    ).toBeUndefined();
  });
  it("reports another tool's hook, before and after Nestrix installs", () => {
    function apmRouteHook() {}
    const adapter = { getOnRouteTriggered: () => apmRouteHook };
    expect(describeForeignRouteHook(adapter)).toMatch(
      /already set .*"apmRouteHook"/,
    );
    expect(describeForeignRouteHook(adapter, ours)).toMatch(
      /replaced Nestrix's/,
    );
  });
  it("never throws", () => {
    expect(
      describeForeignRouteHook({
        getOnRouteTriggered() {
          throw new Error("x");
        },
      }),
    ).toBeUndefined();
  });
});

describe("guardProcessor (fault injection)", () => {
  it("swallows throws and rejections from every method and counts them", async () => {
    const d = recordingDiagnostics();
    const inner: SpanProcessor = {
      onStart() {
        throw new Error("onStart");
      },
      onEnd() {
        throw new Error("onEnd");
      },
      forceFlush: () => Promise.reject(new Error("flush")),
      shutdown() {
        throw new Error("shutdown sync");
      },
    };
    const guarded = guardProcessor(inner, d);
    expect(() => guarded.onStart({} as never, {} as never)).not.toThrow();
    expect(() => guarded.onEnd(fakeSpan)).not.toThrow();
    await expect(guarded.forceFlush()).resolves.toBeUndefined();
    await expect(guarded.shutdown()).resolves.toBeUndefined();
    expect(d.failures.map((f) => f.where)).toEqual([
      "otel.processor.onStart",
      "otel.processor.onEnd",
    ]);
  });
});

describe("createRedactingExporter (fault injection)", () => {
  function results() {
    const got: ExportResult[] = [];
    return { got, cb: (r: ExportResult) => got.push(r) };
  }

  it("a synchronous throw from the inner exporter fails the batch once", () => {
    const d = recordingDiagnostics();
    const c = counters();
    const exporter = createRedactingExporter(
      {
        export() {
          throw new Error("serializer");
        },
        shutdown: () => Promise.resolve(),
      },
      { scrub: undefined, redact: undefined, counters: c, diagnostics: d },
    );
    const { got, cb } = results();
    exporter.export([fakeSpan], cb);
    expect(got).toHaveLength(1);
    expect(got[0]?.code).toBe(ExportResultCode.FAILED);
    expect(d.failures[0]?.where).toBe("otel.exporter.export");
  });

  it("calls back exactly once even if the inner exporter calls twice, and survives a throwing callback", () => {
    const d = recordingDiagnostics();
    const c = counters();
    const exporter = createRedactingExporter(
      {
        export(_spans, done) {
          done({ code: ExportResultCode.SUCCESS });
          done({ code: ExportResultCode.FAILED });
        },
        shutdown: () => Promise.resolve(),
      },
      { scrub: undefined, redact: undefined, counters: c, diagnostics: d },
    );
    const { got, cb } = results();
    exporter.export([fakeSpan], cb);
    expect(got.map((r) => r.code)).toEqual([ExportResultCode.SUCCESS]);
    expect(() =>
      exporter.export([fakeSpan], () => {
        throw new Error("callback");
      }),
    ).not.toThrow();
    expect(d.failures.map((f) => f.where)).toEqual(["otel.exporter.callback"]);
  });

  it("passes spans through untouched without hooks; an all-dropped batch succeeds without calling the exporter", () => {
    const seen: ReadableSpan[][] = [];
    const inner: SpanExporter = {
      export(spans, done) {
        seen.push(spans);
        done({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.reject(new Error("x")),
    };
    const d = recordingDiagnostics();
    const plain = createRedactingExporter(inner, {
      scrub: undefined,
      redact: undefined,
      counters: counters(),
      diagnostics: d,
    });
    const batch = [fakeSpan];
    plain.export(batch, () => {});
    expect(seen[0]).toBe(batch);

    const c = counters();
    const dropping = createRedactingExporter(inner, {
      scrub: undefined,
      redact: () => false,
      counters: c,
      diagnostics: d,
    });
    const { got, cb } = results();
    dropping.export([fakeSpan], cb);
    expect(seen).toHaveLength(1);
    expect(got[0]?.code).toBe(ExportResultCode.SUCCESS);
    expect(c.redactDroppedSpans).toBe(1);
    return expect(plain.shutdown()).resolves.toBeUndefined();
  });
});

describe("createDropCountingMeterProvider", () => {
  it("counts only queue_full on the processed counter; everything else is a no-op", () => {
    let dropped = 0;
    const meter = createDropCountingMeterProvider((n) => {
      dropped += n;
    }).getMeter("x");
    const processed = meter.createCounter("otel.sdk.processor.span.processed");
    processed.add(3, { "error.type": "queue_full" });
    processed.add(5, {});
    processed.add(7, { "error.type": "Error" });
    meter.createCounter("other").add(11, { "error.type": "queue_full" });
    meter.createUpDownCounter("u").add(1);
    meter.createObservableUpDownCounter("o").addCallback(() => {});
    expect(dropped).toBe(3);
    const throwing = createDropCountingMeterProvider(() => {
      throw new Error("x");
    }).getMeter("x");
    expect(() =>
      throwing
        .createCounter("otel.sdk.processor.span.processed")
        .add(1, { "error.type": "queue_full" }),
    ).not.toThrow();
  });
});

describe("misc", () => {
  it("batchExportTimeout never undercuts the exporter's own deadline", () => {
    expect(batchExportTimeout(10_000)).toBe(30_000);
    expect(batchExportTimeout(60_000)).toBe(121_000);
  });
  it("settle resolves on return, throw and rejection", async () => {
    await expect(settle(() => 1)).resolves.toBeUndefined();
    await expect(
      settle(() => {
        throw new Error("x");
      }),
    ).resolves.toBeUndefined();
    await expect(
      settle(() => Promise.reject(new Error("x"))),
    ).resolves.toBeUndefined();
  });
  it("setupTelemetry never throws: a fault during setup gives an inert handle and registers nothing", async () => {
    const d = recordingDiagnostics();
    const broken = {
      serviceName: undefined,
      resourceAttributes: {},
      sampleRate: 1,
      redact: undefined,
      get export(): TelemetryConfig["export"] {
        throw new Error("injected setup fault");
      },
    } as TelemetryConfig;
    const handle = setupTelemetry(broken, d);
    expect(handle.ownsProvider).toBe(false);
    expect(d.failures.map((f) => f.where)).toEqual(["otel.setup"]);
    expect(trace.getTracer("x").startSpan("y").isRecording()).toBe(false);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
