// The server traces itself through NestrixModule but never its own ingest route. A global
// in-memory provider registered first stands in for the host SDK, so Nestrix's spans land here.
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  auth,
  fixture,
  PROTO,
  post,
  startServer,
  type TestServer,
} from "./helpers.js";

const exporter = new InMemorySpanExporter();
let server: TestServer;

beforeAll(async () => {
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    }),
  );
  server = await startServer();
});
afterAll(async () => {
  await server?.close();
  trace.disable();
});

it("creates server spans for other routes but none for POST /v1/traces", async () => {
  for (const path of ["/v1/traces", "/V1/Traces/"]) {
    const res = await post(`${server.baseUrl}${path}`, fixture("traces.pb"), {
      ...auth(),
      "content-type": PROTO,
    });
    expect(res.status).toBe(200);
  }
  const other = await fetch(`${server.baseUrl}/not-a-route`);
  expect(other.status).toBe(404);

  await new Promise((r) => setTimeout(r, 50));
  const spans = exporter.getFinishedSpans();
  const paths = spans.map((s) => String(s.attributes["url.path"] ?? ""));
  expect(paths).toContain("/not-a-route");
  expect(paths.filter((p) => p.toLowerCase().startsWith("/v1/traces"))).toEqual(
    [],
  );
});
