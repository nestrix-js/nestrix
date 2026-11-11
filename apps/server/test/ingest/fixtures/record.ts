// Records real OTLP/HTTP request bodies from the official OpenTelemetry JS exporters into this
// directory, with the spans they carry (`expected.json`) so the replay tests can check the
// decoded result. Run from apps/server: `pnpm record:fixtures` (Node runs this file directly).
// Re-record after upgrading the exporters; the files are checked in.
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter as HttpJsonExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

const here = dirname(fileURLToPath(import.meta.url));

function makeSpans(): ReadableSpan[] {
  const memory = new InMemorySpanExporter();
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": "fixture-service",
      "service.version": "1.2.3",
      "deployment.environment.name": "test",
    }),
    spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
  });
  const tracer = provider.getTracer("fixture-scope", "0.0.1");
  const t0 = Date.now() - 1000;

  const other = tracer.startSpan("other-trace-root", {
    kind: SpanKind.INTERNAL,
    startTime: t0,
  });
  other.end(t0 + 5);

  const root = tracer.startSpan("GET /orders/:id", {
    kind: SpanKind.SERVER,
    startTime: t0 + 10,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/orders/:id",
      "url.path": "/orders/42",
      "http.response.status_code": 200,
      "nestrix.ratio": 0.25,
      "nestrix.flag": true,
      "nestrix.tags": ["a", "b"],
    },
  });
  const child = tracer.startSpan(
    "SELECT orders",
    {
      kind: SpanKind.CLIENT,
      startTime: t0 + 20,
      attributes: { "db.system.name": "postgresql" },
      links: [
        { context: other.spanContext(), attributes: { "link.reason": "x" } },
      ],
    },
    trace.setSpan(ROOT_CONTEXT, root),
  );
  child.recordException(new Error("connection reset"), t0 + 25);
  child.setStatus({ code: SpanStatusCode.ERROR, message: "connection reset" });
  child.end(t0 + 30);
  const producer = tracer.startSpan(
    "orders publish",
    { kind: SpanKind.PRODUCER, startTime: t0 + 31 },
    trace.setSpan(ROOT_CONTEXT, root),
  );
  producer.end(t0 + 32);
  root.setStatus({ code: SpanStatusCode.OK });
  root.end(t0 + 40);

  return memory.getFinishedSpans();
}

interface Captured {
  headers: IncomingMessage["headers"];
  body: Buffer;
}

async function capture(
  makeExporter: (url: string) => {
    export: (
      spans: ReadableSpan[],
      done: (r: { code: number; error?: Error }) => void,
    ) => void;
    shutdown: () => Promise<void>;
  },
  spans: ReadableSpan[],
): Promise<Captured> {
  let captured: Captured | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured = { headers: req.headers, body: Buffer.concat(chunks) };
      const json = String(req.headers["content-type"]).includes("json");
      res.setHeader(
        "content-type",
        json ? "application/json" : "application/x-protobuf",
      );
      res.end(json ? "{}" : Buffer.alloc(0));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const exporter = makeExporter(`http://127.0.0.1:${port}/v1/traces`);
  const result = await new Promise<{ code: number; error?: Error }>((r) =>
    exporter.export(spans, r),
  );
  await exporter.shutdown();
  server.close();
  if (result.code !== 0 || captured === undefined) {
    throw new Error(`export failed: ${result.error?.message ?? "no request"}`);
  }
  return captured;
}

const spans = makeSpans();
const variants = [
  { file: "traces.pb", Exporter: ProtoExporter, compression: "none" },
  { file: "traces.pb.gz", Exporter: ProtoExporter, compression: "gzip" },
  { file: "traces.json", Exporter: HttpJsonExporter, compression: "none" },
  { file: "traces.json.gz", Exporter: HttpJsonExporter, compression: "gzip" },
] as const;

const requests: Record<
  string,
  { contentType: string; contentEncoding?: string }
> = {};
for (const v of variants) {
  const got = await capture(
    (url) =>
      new v.Exporter({
        url,
        // The exporters type this as their CompressionAlgorithm enum, whose values are these strings.
        compression: v.compression as never,
      }),
    spans,
  );
  writeFileSync(join(here, v.file), got.body);
  requests[v.file] = {
    contentType: String(got.headers["content-type"]),
    ...(got.headers["content-encoding"]
      ? { contentEncoding: String(got.headers["content-encoding"]) }
      : {}),
  };
  console.log(
    `${v.file}: ${got.body.length} bytes, ${requests[v.file].contentType}`,
  );
}

const kinds = ["internal", "server", "client", "producer", "consumer"];
const expected = {
  recordedWith: {
    "@opentelemetry/exporter-trace-otlp-proto": "0.301.1",
    "@opentelemetry/exporter-trace-otlp-http": "0.301.1",
  },
  requests,
  resource: {
    "service.name": "fixture-service",
    "service.version": "1.2.3",
  },
  spans: spans.map((s) => ({
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentSpanId: s.parentSpanContext?.spanId,
    name: s.name,
    kind: kinds[s.kind],
    startTimeUnixNano: (
      BigInt(s.startTime[0]) * 1_000_000_000n +
      BigInt(s.startTime[1])
    ).toString(),
    endTimeUnixNano: (
      BigInt(s.endTime[0]) * 1_000_000_000n +
      BigInt(s.endTime[1])
    ).toString(),
    status: ["unset", "ok", "error"][s.status.code],
    events: s.events.map((e) => e.name),
    links: s.links.map((l) => l.context.spanId),
    attributes: s.attributes,
  })),
};
writeFileSync(
  join(here, "expected.json"),
  `${JSON.stringify(expected, null, 2)}\n`,
);
console.log(`expected.json: ${spans.length} spans`);
