// Global state: no host SDK. Nestrix owns the provider (setupTelemetry) and exports over OTLP/HTTP
// to a local stub. Its exporter sends through node:http, so the node:http subscriber sees every
// export request; none may become a span or carry a traceparent.
import dc from "node:diagnostics_channel";
import http from "node:http";
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTelemetry } from "../src/otel/setup.js";
import type { TelemetryHandle } from "../src/otel/types.js";
import { installOutbound } from "../src/outbound/index.js";
import {
  config,
  otlp,
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";
import {
  type EchoServer,
  resolved,
  startEchoServer,
} from "./outbound-helpers.js";

let receiver: Receiver;
let echo: EchoServer;
let handle: TelemetryHandle;
let uninstall: () => void;
const diagnostics = recordingDiagnostics();

/** Every node:http request to the OTLP stub, with whether it carried a traceparent when sent. */
const exportRequests: { traceparent: boolean }[] = [];
const spy = (message: unknown): void => {
  const { request } = message as { request: http.ClientRequest };
  if (request.path === "/v1/traces")
    exportRequests.push({ traceparent: request.hasHeader("traceparent") });
};

function get(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  receiver = await startReceiver();
  echo = await startEchoServer();
  // Installed before any provider exists: the subscribers obtain their tracer at use time.
  uninstall = installOutbound(resolved(), diagnostics);
  handle = setupTelemetry(
    config({
      export: {
        otlp: otlp(receiver.url),
        queue: {
          maxQueueSize: 100,
          maxExportBatchSize: 10,
          scheduledDelayMillis: 20,
        },
      },
    }),
    diagnostics,
  );
  // Subscribed after Nestrix, so it sees the request after Nestrix's subscriber ran.
  dc.subscribe("http.client.response.finish", spy);
});
afterAll(async () => {
  dc.unsubscribe("http.client.response.finish", spy);
  uninstall();
  await handle.shutdown();
  await echo.close();
  await receiver.close();
});

describe("Nestrix's own export requests", () => {
  it("owns the provider", () => {
    expect(handle.ownsProvider).toBe(true);
  });

  it("produce no spans and send no traceparent, including an export made while a span is active", async () => {
    await trace.getTracer("test").startActiveSpan("parent", async (parent) => {
      expect(await get(`${echo.base}/ok`)).toBe(200);
      // The client span is queued; flushing now runs the exporter's POST inside this active
      // span's context, so only the suppress-tracing key keeps it from becoming a child span.
      await handle.forceFlush();
      parent.end();
    });
    await handle.forceFlush();
    await receiver.waitForSpans(2);

    const names = receiver.spans.map((s) => s.name).sort();
    expect(names).toEqual(["GET", "parent"]);
    const client = receiver.spans.find((s) => s.name === "GET");
    const parent = receiver.spans.find((s) => s.name === "parent");
    expect(client?.parentSpanId).toBe(parent?.spanId);
    expect(client?.attributes["url.full"]).toBe(`${echo.base}/ok`);
    expect(echo.received[0]?.traceparent).toHaveLength(1);

    // The exporter's requests went through node:http (the subscriber saw them) ...
    expect(exportRequests.length).toBeGreaterThanOrEqual(2);
    expect(receiver.posts).toBe(exportRequests.length);
    // ... and none of them was traced or carried a header.
    expect(exportRequests.every((r) => r.traceparent === false)).toBe(true);
    expect(
      receiver.spans.filter((s) =>
        String(s.attributes["url.full"] ?? "").includes("/v1/traces"),
      ),
    ).toEqual([]);
    expect(diagnostics.failures).toEqual([]);
  });

  it("background exports (timer-driven, no active span) are not traced either", async () => {
    const before = receiver.spans.length;
    await trace.getTracer("test").startActiveSpan("bg", async (span) => {
      await get(`${echo.base}/ok`);
      span.end();
    });
    await receiver.waitForSpans(before + 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(
      receiver.spans
        .slice(before)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["GET", "bg"]);
  });
});
