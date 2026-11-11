// Helpers for the otel-*.test.ts files. Not a test file itself.
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  TelemetryConfig,
  TelemetryDiagnostics,
} from "../src/otel/types.js";

export interface ReceivedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
  resource: Record<string, unknown>;
}

interface OtlpKeyValue {
  key: string;
  value: Record<string, unknown>;
}

function anyValue(value: Record<string, unknown>): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("arrayValue" in value) {
    const values = (value.arrayValue as { values?: Record<string, unknown>[] })
      .values;
    return (values ?? []).map(anyValue);
  }
  return value;
}

function attrs(list: OtlpKeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) out[kv.key] = anyValue(kv.value);
  return out;
}

/** A plain `node:http` server that accepts OTLP/HTTP JSON on `/v1/traces` and keeps what it got. */
export interface Receiver {
  url: string;
  posts: number;
  spans: ReceivedSpan[];
  waitForSpans(count: number, timeoutMs?: number): Promise<ReceivedSpan[]>;
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const receiver = {
    url: "",
    posts: 0,
    spans: [] as ReceivedSpan[],
  } as Receiver;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/traces") {
        receiver.posts++;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const rs of body.resourceSpans ?? []) {
          const resource = attrs(rs.resource?.attributes);
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) {
              receiver.spans.push({
                name: s.name,
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId || undefined,
                attributes: attrs(s.attributes),
                events: (s.events ?? []).map(
                  (e: { name: string; attributes?: OtlpKeyValue[] }) => ({
                    name: e.name,
                    attributes: attrs(e.attributes),
                  }),
                ),
                resource,
              });
            }
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  receiver.url = `http://127.0.0.1:${port}/v1/traces`;
  receiver.waitForSpans = async (count, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (receiver.spans.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `receiver: expected ${count} spans, got ${receiver.spans.length}: ${receiver.spans.map((s) => s.name).join(", ")}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return receiver.spans;
  };
  receiver.close = async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  };
  return receiver;
}

/** A URL on a port that refuses connections: bind, read the port, close. */
export async function unreachableUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return `http://127.0.0.1:${port}/v1/traces`;
}

export interface RecordingDiagnostics extends TelemetryDiagnostics {
  logs: Map<string, string>;
  failures: { where: string; error: unknown }[];
}

export function recordingDiagnostics(): RecordingDiagnostics {
  const logs = new Map<string, string>();
  const failures: { where: string; error: unknown }[] = [];
  return {
    logs,
    failures,
    logOnce(key, message) {
      if (!logs.has(key)) logs.set(key, message);
    },
    countFailure(where, error) {
      failures.push({ where, error });
    },
  };
}

export function config(
  overrides: Partial<TelemetryConfig> = {},
): TelemetryConfig {
  return {
    serviceName: "otel-test",
    resourceAttributes: {},
    sampleRate: 1,
    export: {
      otlp: false,
      queue: {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 50,
      },
    },
    redact: undefined,
    ...overrides,
  };
}

export function otlp(url: string, timeoutMillis = 2000) {
  return { url, headers: {}, timeoutMillis };
}
