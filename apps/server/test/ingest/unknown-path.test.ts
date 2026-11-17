// #39: a /v1/* path the server does not ingest (POST /v1/metrics from an app's metric exporter)
// answers 404 with an OTLP google.rpc.Status body, before the admin login and without a key.
import { request as httpRequest } from "node:http";
import { fromBinary } from "@bufbuild/protobuf";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNKNOWN_OTLP_PATH_MESSAGE } from "../../src/ingest/unknown-path.js";
import { StatusSchema } from "../../src/proto/gen/google/rpc/status_pb.js";
import {
  auth,
  fixture,
  JSON_TYPE,
  PROTO,
  post,
  startServer,
  type TestServer,
  testConfig,
} from "./helpers.js";

function rawRequest(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    // `path` as is: a URL would resolve its dot segments before sending.
    const req = httpRequest(
      { hostname, port, path, method, headers },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("unknown OTLP paths", () => {
  let server: TestServer;
  beforeAll(async () => {
    // No admin password: the admin layer would answer 503 to anything it handles.
    server = await startServer(testConfig());
  });
  afterAll(async () => {
    await server.close();
  });

  it("POST /v1/metrics answers 404 with a JSON google.rpc.Status, without a key", async () => {
    const res = await post(`${server.baseUrl}/v1/metrics`, "{}", {
      "content-type": JSON_TYPE,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(JSON_TYPE);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = await res.json();
    expect(body).toEqual({ code: 5, message: UNKNOWN_OTLP_PATH_MESSAGE });
  });

  it("answers in protobuf for a protobuf request, with or without a key", async () => {
    for (const headers of [{}, auth()]) {
      const res = await post(
        `${server.baseUrl}/v1/metrics`,
        fixture("traces.pb"),
        { ...headers, "content-type": PROTO },
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe(PROTO);
      const status = fromBinary(
        StatusSchema,
        new Uint8Array(await res.arrayBuffer()),
      );
      expect(status.code).toBe(5);
      expect(status.message).toBe(UNKNOWN_OTLP_PATH_MESSAGE);
    }
  });

  it("covers every /v1/* path that is not an ingest route, and any method", async () => {
    for (const [method, path] of [
      ["POST", "/v1/metrics/"],
      ["POST", "/V1/Metrics"],
      ["POST", "/v1/profiles"],
      ["POST", "/v1/tracesx"],
      ["GET", "/v1/metrics"],
      ["GET", "/v1/"],
      ["PUT", "/v1/nestrix/unknown"],
    ] as const) {
      const res = await rawRequest(server.baseUrl, method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers["content-type"], path).toBe(JSON_TYPE);
    }
  });

  it("leaves ingest routes, dot segments and escapes to the existing layers", async () => {
    const ingest = await post(server.url, fixture("traces.pb"), {
      ...auth(),
      "content-type": PROTO,
    });
    expect(ingest.status).toBe(200);
    // No key: the receiver's 401, not this 404.
    const noKey = await post(server.url, fixture("traces.pb"), {
      "content-type": PROTO,
    });
    expect(noKey.status).toBe(401);
    // Not an OTLP path for this layer: the admin login decides (503 without a password).
    for (const path of [
      "/v1/traces/../api/v1/probe",
      "/v1/%6detrics",
      "/v1/./metrics",
      "/api/v1/meta",
    ]) {
      const res = await rawRequest(server.baseUrl, "GET", path);
      expect(res.status, path).toBe(503);
    }
  });

  it("an OTLP exporter pointed at /v1/metrics gets a non-retried 404", async () => {
    const exporter = new OTLPTraceExporter({
      url: `${server.baseUrl}/v1/metrics`,
      timeoutMillis: 5000,
    });
    const started = Date.now();
    const result = await new Promise<{ code: number; error?: Error }>(
      (resolve) => exporter.export([], resolve),
    );
    await exporter.shutdown();
    expect(result.code).toBe(1); // FAILED
    expect((result.error as { code?: unknown } | undefined)?.code).toBe(404);
    expect(Date.now() - started).toBeLessThan(2000); // not retried
  });
});
