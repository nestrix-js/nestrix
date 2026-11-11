import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { INestApplication, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { NodeAdapter } from "@nestjs/platform-node";
import { Test } from "@nestjs/testing";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { AppModule } from "express-esm/app.module";

export type AdapterName = "express" | "fastify" | "node";

export interface BootOptions {
  /** Root module. Defaults to the fixture `AppModule` from `examples/express-esm`. */
  module?: Type;
  /** Placeholder for the future `NestrixModule.forRoot()` options. Stored on the result, not interpreted. */
  moduleOptions?: unknown;
  /** Build through `Test.createTestingModule(...).compile()` instead of `NestFactory.create`. */
  testing?: boolean;
  /** Runs after the app is created and before `init`/`listen`: global prefix, versioning, middleware. */
  configure?: (app: INestApplication) => unknown;
}

export interface WaitOptions {
  timeoutMs?: number;
}

export interface BootedApp {
  app: INestApplication;
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  baseUrl: string;
  moduleOptions: unknown;
  /** Spans finished since this app booted. */
  spans: () => ReadableSpan[];
  /** Resolves with the first finished span of that name; rejects on timeout listing what was captured. */
  waitForSpan: (name: string, opts?: WaitOptions) => Promise<ReadableSpan>;
  close: () => Promise<void>;
}

const HOST = "127.0.0.1";

// OpenTelemetry globals are per process, so there is one exporter and one provider.
let exporter: InMemorySpanExporter | undefined;
let provider: TracerProvider | undefined;
let open = false;

function ensureTracing(): InMemorySpanExporter {
  if (!exporter) {
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    // Returns false (and keeps the existing provider) if something registered one first.
    if (!trace.setGlobalTracerProvider(provider)) {
      throw new Error(
        "@nestrix/testing: a global tracer provider is already registered, spans would not reach the in-memory exporter",
      );
    }
  }
  return exporter;
}

function createAdapter(adapter: AdapterName) {
  switch (adapter) {
    case "express":
      return new ExpressAdapter();
    case "fastify": {
      const fastify = new FastifyAdapter();
      // Fastify answers 415 to multipart/form-data unless a parser is registered.
      // This one leaves the body unread, like examples/fastify-esm.
      fastify
        .getInstance()
        .addContentTypeParser("multipart/form-data", (_req, _payload, done) =>
          done(null),
        );
      return fastify;
    }
    case "node":
      return new NodeAdapter();
    default:
      throw new Error(`@nestrix/testing: unknown adapter "${String(adapter)}"`);
  }
}

export async function bootApp(
  adapter: AdapterName,
  options: BootOptions = {},
): Promise<BootedApp> {
  if (open) {
    throw new Error(
      "@nestrix/testing: another app is still open. Spans are captured per process, so only one app can be booted at a time; await close() first.",
    );
  }
  open = true;
  const spanExporter = ensureTracing();
  spanExporter.reset();
  let app: INestApplication | undefined;
  try {
    const module = options.module ?? AppModule;
    const adapterInstance = createAdapter(adapter);
    if (options.testing) {
      const moduleRef = await Test.createTestingModule({
        imports: [module],
      }).compile();
      app = moduleRef.createNestApplication(adapterInstance);
    } else {
      app = await NestFactory.create(module, adapterInstance);
    }
    await options.configure?.(app);
    await app.listen(0, HOST);
    const address = app.getHttpServer().address() as
      | AddressInfo
      | string
      | null;
    if (!address || typeof address === "string") {
      throw new Error(
        "@nestrix/testing: server has no TCP address after listen",
      );
    }
    const booted = app;
    let closed = false;
    return {
      app: booted,
      baseUrl: `http://${HOST}:${address.port}`,
      moduleOptions: options.moduleOptions,
      spans: () => spanExporter.getFinishedSpans(),
      async waitForSpan(name, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 2000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const found = spanExporter
            .getFinishedSpans()
            .find((s) => s.name === name);
          if (found) return found;
          if (Date.now() >= deadline) {
            const names = spanExporter.getFinishedSpans().map((s) => s.name);
            throw new Error(
              `waitForSpan("${name}") timed out after ${timeoutMs}ms. Captured spans: ${
                names.length ? names.map((n) => `"${n}"`).join(", ") : "(none)"
              }`,
            );
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await booted.close();
          await provider?.forceFlush();
        } finally {
          spanExporter.reset();
          open = false;
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } catch {
      // The boot error is the one worth reporting.
    }
    spanExporter.reset();
    open = false;
    throw error;
  }
}

export type { ReadableSpan };
