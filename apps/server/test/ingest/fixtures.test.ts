// Recorded bodies from the official exporters (fixtures/record.ts), replayed against the
// receiver, and the official exporters run live against it.
import { fromBinary } from "@bufbuild/protobuf";
import { OTLPTraceExporter as HttpJsonExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExportTraceServiceResponseSchema } from "../../src/proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import {
  auth,
  expected,
  fixture,
  KEY,
  post,
  startServer,
  type TestServer,
} from "./helpers.js";

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.close();
});

const files = ["traces.pb", "traces.pb.gz", "traces.json", "traces.json.gz"];

describe("recorded payloads from the official exporters", () => {
  for (const file of files) {
    it(`decodes ${file}`, async () => {
      const meta = expected.requests[file];
      const before = server.sink.batches.length;
      const headers: Record<string, string> = {
        ...auth(),
        "content-type": meta.contentType,
      };
      if (meta.contentEncoding)
        headers["content-encoding"] = meta.contentEncoding;
      const res = await post(server.url, fixture(file), headers);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(meta.contentType);
      const body = new Uint8Array(await res.arrayBuffer());
      if (meta.contentType === "application/json") {
        expect(new TextDecoder().decode(body)).toBe("{}");
      } else {
        // Full success: partial_success unset.
        const decoded = fromBinary(ExportTraceServiceResponseSchema, body);
        expect(decoded.partialSuccess).toBeUndefined();
        expect(body.length).toBe(0);
      }

      expect(server.sink.batches.length).toBe(before + 1);
      const batch = server.sink.batches[before];
      expect(batch.rejectedSpans).toBe(0);
      expect(batch.resourceSpans).toHaveLength(1);
      const rs = batch.resourceSpans[0];
      expect(rs.resource["service.name"]).toBe(
        expected.resource["service.name"],
      );
      expect(rs.resource["service.version"]).toBe(
        expected.resource["service.version"],
      );
      expect(rs.spans).toHaveLength(expected.spans.length);
      for (const want of expected.spans) {
        const got = rs.spans.find((s) => s.spanId === want.spanId);
        expect(got, want.name).toBeDefined();
        if (!got) continue;
        expect(got.traceId).toBe(want.traceId);
        expect(got.parentSpanId).toBe(want.parentSpanId);
        expect(got.name).toBe(want.name);
        expect(got.kind).toBe(want.kind);
        expect(got.startTimeUnixNano).toBe(BigInt(want.startTimeUnixNano));
        expect(got.endTimeUnixNano).toBe(BigInt(want.endTimeUnixNano));
        expect(got.status.code).toBe(want.status);
        expect(got.events.map((e) => e.name)).toEqual(want.events);
        expect(got.links.map((l) => l.spanId)).toEqual(want.links);
        expect({ ...got.attributes }).toEqual(want.attributes);
        expect(got.scope).toBe("fixture-scope");
      }
      const errored = rs.spans.find((s) => s.name === "SELECT orders");
      expect(errored?.status).toEqual({
        code: "error",
        message: "connection reset",
      });
      expect(errored?.events[0].attributes["exception.message"]).toBe(
        "connection reset",
      );
      expect(errored?.links[0].attributes["link.reason"]).toBe("x");
    });
  }
});

describe("official exporters, live", () => {
  const variants = [
    { name: "protobuf", Exporter: ProtoExporter, compression: "none" },
    { name: "protobuf + gzip", Exporter: ProtoExporter, compression: "gzip" },
    { name: "json", Exporter: HttpJsonExporter, compression: "none" },
    { name: "json + gzip", Exporter: HttpJsonExporter, compression: "gzip" },
  ] as const;

  for (const v of variants) {
    it(`accepts an export: ${v.name}`, async () => {
      const exporter = new v.Exporter({
        url: server.url,
        headers: { authorization: `Bearer ${KEY}` },
        compression: v.compression as never,
      });
      const memory = new InMemorySpanExporter();
      const provider = new TracerProvider({
        resource: resourceFromAttributes({ "service.name": `live-${v.name}` }),
        spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
      });
      const span = provider.getTracer("live").startSpan(`live ${v.name}`);
      span.end();
      const result = await new Promise<{ code: number; error?: Error }>((r) =>
        exporter.export(memory.getFinishedSpans(), r),
      );
      await exporter.shutdown();
      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
      const stored = server.sink
        .spans()
        .find((s) => s.name === `live ${v.name}`);
      expect(stored?.spanId).toBe(span.spanContext().spanId);
    });
  }

  it("reports a rejected key to the exporter as a failure", async () => {
    const exporter = new ProtoExporter({
      url: server.url,
      headers: { authorization: "Bearer wrong-key" },
    });
    const memory = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
    });
    provider.getTracer("live").startSpan("unauthorised").end();
    const result = await new Promise<{ code: number; error?: Error }>((r) =>
      exporter.export(memory.getFinishedSpans(), r),
    );
    await exporter.shutdown();
    expect(result.code).toBe(1);
    expect(String(result.error?.message)).toMatch(/401|Unauthorized/i);
  });
});
