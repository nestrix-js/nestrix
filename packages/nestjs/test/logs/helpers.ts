// Helpers for test/logs. Not a test file itself.
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { vi } from "vitest";

export interface ReceivedLog {
  body: unknown;
  severityNumber: number;
  severityText: string | undefined;
  traceId: string | undefined;
  spanId: string | undefined;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
}

interface KeyValue {
  key: string;
  value: Record<string, unknown>;
}

function plain(list: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) {
    out[kv.key] = Object.values(kv.value)[0];
  }
  return out;
}

export interface LogReceiver {
  /** Base URL, no path: pass it as `export.otlp.endpoint`. */
  baseUrl: string;
  logs: ReceivedLog[];
  paths: string[];
  waitForLogs(count: number, timeoutMs?: number): Promise<ReceivedLog[]>;
  close(): Promise<void>;
}

/** Accepts OTLP/HTTP JSON on `/v1/logs`; answers 200 to every other POST (traces). */
export async function startLogReceiver(): Promise<LogReceiver> {
  const receiver = {
    baseUrl: "",
    logs: [],
    paths: [],
  } as unknown as LogReceiver;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      receiver.paths.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url === "/v1/logs") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const rl of body.resourceLogs ?? []) {
          const resource = plain(rl.resource?.attributes);
          for (const sl of rl.scopeLogs ?? []) {
            for (const record of sl.logRecords ?? []) {
              receiver.logs.push({
                body: Object.values(record.body ?? {})[0],
                severityNumber: record.severityNumber,
                severityText: record.severityText,
                traceId: record.traceId || undefined,
                spanId: record.spanId || undefined,
                attributes: plain(record.attributes),
                resource,
              });
            }
          }
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  receiver.baseUrl = `http://127.0.0.1:${port}`;
  receiver.waitForLogs = async (count, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (receiver.logs.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `log receiver: expected ${count} records, got ${receiver.logs.length}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return receiver.logs;
  };
  receiver.close = async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  };
  return receiver;
}

/** A host tracer provider and context manager, as an app with its own SDK has. Returns the undo. */
export function registerHostTracing(): () => void {
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  const provider = new TracerProvider();
  trace.setGlobalTracerProvider(provider);
  return () => {
    trace.disable();
    context.disable();
    manager.disable();
    void provider.shutdown();
  };
}

/** Collects what is written to stdout and stderr while it is active. */
export function captureOutput(): {
  lines: () => string[];
  restore: () => void;
} {
  const chunks: string[] = [];
  const write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  const out = vi.spyOn(process.stdout, "write").mockImplementation(write);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(write);
  return {
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line !== ""),
    restore() {
      out.mockRestore();
      err.mockRestore();
    },
  };
}
