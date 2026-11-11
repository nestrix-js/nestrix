// Shared helpers for the level 2 tests. Not a test file itself.
//
// `@nestrix-js/testing`'s `bootApp` takes no `instrument` option, so these tests boot apps themselves.
// Each test file runs in its own worker, so each registers its own global provider here.
import "reflect-metadata";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  INestApplication,
  INestApplicationContext,
  Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  type MethodCallSink,
  type MethodClassKind,
  setMethodCallSink,
} from "../../src/methods/sink.js";

export const ADAPTERS = ["express", "fastify", "node"] as const;
export type AdapterName = (typeof ADAPTERS)[number];

let exporter: InMemorySpanExporter | undefined;

/** Registers a host provider with an in-memory exporter, a context manager and a propagator. */
export function setupTracing(): InMemorySpanExporter {
  if (exporter) return exporter;
  exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    throw new Error("a global tracer provider is already registered");
  }
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return exporter;
}

export function spanNames(): string[] {
  return (exporter?.getFinishedSpans() ?? []).map((s) => s.name);
}

export function spans(): ReadableSpan[] {
  return exporter?.getFinishedSpans() ?? [];
}

export function resetSpans(): void {
  exporter?.reset();
}

export function methodSpans(): ReadableSpan[] {
  return spans().filter((s) => s.attributes["nestrix.class"] !== undefined);
}

// The platform packages are dependencies of `@nestrix-js/testing`, not of this package (as in
// `dashboard-fixture.ts`: one pnpm peer set, the same `@nestjs/core` instance).
const fromTesting = createRequire(
  fileURLToPath(import.meta.resolve("@nestrix-js/testing")),
);
const PLATFORM = {
  express: ["@nestjs/platform-express", "ExpressAdapter"],
  fastify: ["@nestjs/platform-fastify", "FastifyAdapter"],
  node: ["@nestjs/platform-node", "NodeAdapter"],
} as const;

async function createAdapter(adapter: AdapterName): Promise<never> {
  const [pkg, name] = PLATFORM[adapter];
  const mod = (await import(
    pathToFileURL(fromTesting.resolve(pkg)).href
  )) as Record<string, new () => unknown>;
  return new (mod[name] as new () => unknown)() as never;
}

export interface Instrumented {
  app: INestApplication;
  baseUrl: string;
  get(path: string): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

/** `NestFactory.create(module, adapter, { instrument })`, listening on a random port. */
export async function bootInstrumented(
  adapter: AdapterName,
  module: Type,
  instrument?: { instanceDecorator: (i: unknown) => unknown },
): Promise<Instrumented> {
  const app = await NestFactory.create(module, await createAdapter(adapter), {
    logger: false,
    abortOnError: false,
    ...(instrument ? { instrument } : {}),
  });
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    app,
    baseUrl,
    async get(path) {
      const res = await fetch(`${baseUrl}${path}`);
      return { status: res.status, body: await res.text() };
    },
    close: () => app.close(),
  };
}

/** `NestFactory.createApplicationContext(module, { instrument })` (no HTTP adapter). */
export function contextInstrumented(
  module: Type,
  instrument?: { instanceDecorator: (i: unknown) => unknown },
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, {
    logger: false,
    abortOnError: false,
    ...(instrument ? { instrument } : {}),
  });
}

export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end)
      throw new Error(`condition not met in ${timeoutMs}ms`);
    await sleep(10);
  }
}

export function serverSpanOf(path: string): ReadableSpan | undefined {
  return spans().find(
    (s) => s.kind === SpanKind.SERVER && s.attributes["url.path"] === path,
  );
}

export interface RecordedCall {
  className: string;
  kind: MethodClassKind;
  method: string;
  durationMs: number;
  error: boolean;
}

/** Installs a sink that keeps every call; returns the list and a disposer. */
export function recordingSink(): {
  calls: RecordedCall[];
  dispose: () => void;
} {
  const calls: RecordedCall[] = [];
  const sink: MethodCallSink = {
    record(className, kind, method, durationMs, error) {
      calls.push({ className, kind, method, durationMs, error });
    },
  };
  return { calls, dispose: setMethodCallSink(sink) };
}

/**
 * Runs `fn` with a valid, sampled span active (a non-recording parent that exports nothing). A
 * method called with no valid active span gets no span (D-67), so tests of the span itself call
 * it from here.
 */
export function inParent<T>(fn: () => T): T {
  const parent = trace.setSpan(
    context.active(),
    trace.wrapSpanContext({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    }),
  );
  return context.with(parent, fn);
}

/** Options every level 2 test app uses: no export, no dashboard. */
export const BASE_OPTIONS = {
  export: { otlp: false as const },
  ui: false as const,
};
