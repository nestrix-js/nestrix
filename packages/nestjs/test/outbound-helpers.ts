// Helpers for the outbound-*.test.ts files. Not a test file itself.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Context,
  context,
  DiagLogLevel,
  diag,
  propagation,
  ROOT_CONTEXT,
  type Span,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { NestrixModuleOptions } from "../src/options.js";
import { SUPPRESS_TRACING_KEY } from "../src/outbound/rules.js";
import {
  type ResolvedOptions,
  resolveOptions,
} from "../src/resolve-options.js";

/** Registers a host-style provider with an in-memory exporter, the ALS manager and W3C. */
export function setupTestTracing(): {
  exporter: InMemorySpanExporter;
  provider: TracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return { exporter, provider };
}

export function resolved(options: NestrixModuleOptions = {}): ResolvedOptions {
  return resolveOptions(options, {});
}

/** Runs `fn` inside an active, sampled parent span and returns the parent with the result. */
export async function inParent<T>(
  fn: () => Promise<T> | T,
): Promise<{ parent: Span; result: T }> {
  const parent = trace.getTracer("test").startSpan("parent");
  try {
    const result = await context.with(
      trace.setSpan(context.active(), parent),
      fn,
    );
    return { parent, result };
  } finally {
    parent.end();
  }
}

/** A context with an unsampled (but valid) parent span context. */
export function unsampledParent(): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.NONE,
    isRemote: true,
  });
}

/** `ctx` with OpenTelemetry's suppress-tracing key set, as the SDK's `suppressTracing` does. */
export function suppressed(ctx: Context): Context {
  return ctx.setValue(SUPPRESS_TRACING_KEY, true);
}

export function clientSpans(exporter: InMemorySpanExporter): ReadableSpan[] {
  return exporter
    .getFinishedSpans()
    .filter((s) => s.instrumentationScope.name === "@nestrix/nestjs");
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export interface Received {
  url: string;
  traceparent: string[];
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A local server with the routes the outbound tests need. Records every request's
 * `traceparent` header values (raw, so duplicates show) in arrival order.
 */
export interface EchoServer {
  base: string;
  port: number;
  received: Received[];
  close(): Promise<void>;
}

export async function startEchoServer(): Promise<EchoServer> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const traceparent: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === "traceparent")
        traceparent.push(req.rawHeaders[i + 1] ?? "");
    }
    received.push({ url: req.url ?? "", traceparent, headers: req.headers });
    const path = (req.url ?? "/").split("?")[0];
    switch (path) {
      case "/ok":
        res.setHeader("content-type", "text/plain");
        res.setHeader("x-not-listed", "hidden");
        res.end("ok");
        return;
      case "/500":
        res.statusCode = 500;
        res.end("no");
        return;
      case "/404":
        res.statusCode = 404;
        res.end("missing");
        return;
      case "/slow-body": {
        res.write("a".repeat(1000));
        const t = setTimeout(() => res.end("b".repeat(1000)), 300);
        res.on("close", () => clearTimeout(t));
        return;
      }
      case "/big":
        res.end(Buffer.alloc(8 * 1024 * 1024, 120));
        return;
      case "/hang":
        return;
      case "/redirect":
        res.statusCode = 302;
        res.setHeader("location", "/ok");
        res.end();
        return;
      case "/destroy":
        req.socket.destroy();
        return;
      case "/cut-mid": {
        // The server cuts the connection after the head and a first chunk.
        res.write("a".repeat(1000));
        const t = setTimeout(() => req.socket.destroy(), 50);
        res.on("close", () => clearTimeout(t));
        return;
      }
      default:
        res.end();
    }
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key === "string") {
      // A WebSocket handshake that a client accepts; the socket closes shortly after.
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      setTimeout(() => socket.destroy(), 50);
      return;
    }
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    received,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address() as AddressInfo;
  s.close();
  await once(s, "close");
  return port;
}

/**
 * Records every second `end()` on a span. The SDK ignores it and writes
 * `You can only call end() on a span once.` through `diag.error` (sdk-trace 3.1.1 `Span.mjs:176`),
 * so the finished-span list alone cannot show a double end.
 */
export function trackDoubleEnds(): string[] {
  const doubleEnds: string[] = [];
  const record = (message: string) => {
    if (message.includes("You can only call end() on a span once"))
      doubleEnds.push(message);
  };
  diag.setLogger(
    {
      error: record,
      warn: record,
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    },
    DiagLogLevel.WARN,
  );
  return doubleEnds;
}

/** Collects `uncaughtException`s while a test runs (a throwing subscriber would raise one). */
export function trackUncaught(): { errors: unknown[]; stop(): void } {
  const errors: unknown[] = [];
  const handler = (e: unknown) => errors.push(e);
  process.on("uncaughtException", handler);
  return {
    errors,
    stop: () => process.off("uncaughtException", handler),
  };
}
