import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { INestApplication, LoggerService, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";

export type AdapterName = "express" | "fastify" | "node";

/** Adapters under test. The Nest 12.0.0 run sets `SPIKE_ADAPTERS=express,fastify`. */
export const ADAPTERS: AdapterName[] = (
  process.env.SPIKE_ADAPTERS ?? "express,fastify,node"
).split(",") as AdapterName[];

/** Nest version under test, for labels only. */
export const NEST_LABEL = process.env.SPIKE_NEST ?? "12.4.2";

/**
 * Before 12.1.3 the Express and Fastify adapters call the request hook bare: no
 * try/catch, no once-guard on `done`, and the hook's promise is ignored (checked in
 * the published adapter source of every 12.x version; see docs/spikes/P0-S1.md).
 */
export const BARE_HOOK_RUNNER = NEST_LABEL === "12.0.0";

/**
 * platform-node's body parsers bind `next` to the request's async context from
 * 12.3.2 on (`bindAsyncScope` in body-parser.js); 12.3.0 and 12.3.1 do not.
 */
export const NODE_JSON_PARSER_LOSES_STORE = NEST_LABEL === "12.3.0";

export interface LogLine {
  level: string;
  message: string;
}

export const logs: LogLine[] = [];

function stringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Captures Nest's log output so tests can assert what was logged. */
export const captureLogger: LoggerService = {
  log: (m: unknown) => logs.push({ level: "log", message: stringify(m) }),
  error: (m: unknown, ...rest: unknown[]) =>
    logs.push({
      level: "error",
      message: [m, ...rest].map(stringify).join(" "),
    }),
  warn: (m: unknown) => logs.push({ level: "warn", message: stringify(m) }),
  debug: () => {},
  verbose: () => {},
};

async function createAdapter(adapter: AdapterName): Promise<unknown> {
  switch (adapter) {
    case "express": {
      const { ExpressAdapter } = await import("@nestjs/platform-express");
      return new ExpressAdapter();
    }
    case "fastify": {
      const { FastifyAdapter } = await import("@nestjs/platform-fastify");
      const fastify = new FastifyAdapter();
      // As in examples/fastify-esm: pass multipart through unread.
      fastify
        .getInstance()
        .addContentTypeParser(
          "multipart/form-data",
          (_req: unknown, _payload: unknown, done: (e: null) => void) =>
            done(null),
        );
      return fastify;
    }
    case "node": {
      const { NodeAdapter } = await import("@nestjs/platform-node");
      return new NodeAdapter();
    }
  }
}

export interface Booted {
  app: INestApplication;
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
}

export interface BootOptions {
  testing?: boolean;
  configure?: (app: INestApplication) => unknown;
  /** An adapter built by the test (e.g. around a host-supplied server instance). */
  adapterInstance?: unknown;
}

let open: INestApplication | undefined;

/** Boots `module` on `adapter`, listening on 127.0.0.1:0. One app at a time. */
export async function boot(
  adapter: AdapterName,
  module: Type,
  options: BootOptions = {},
): Promise<Booted> {
  if (open) throw new Error("spike: another app is still open");
  const httpAdapter = (options.adapterInstance ??
    (await createAdapter(adapter))) as Parameters<typeof NestFactory.create>[1];
  let app: INestApplication;
  if (options.testing) {
    const moduleRef = await Test.createTestingModule({
      imports: [module],
    }).compile();
    app = moduleRef.createNestApplication(httpAdapter as never, {
      logger: captureLogger,
      abortOnError: false,
    });
  } else {
    app = await NestFactory.create(module, httpAdapter as never, {
      logger: captureLogger,
      abortOnError: false,
    });
  }
  open = app;
  try {
    await options.configure?.(app);
    await app.listen(0, "127.0.0.1");
  } catch (error) {
    open = undefined;
    await app.close().catch(() => {});
    throw error;
  }
  const address = app.getHttpServer().address() as AddressInfo;
  let closed = false;
  return {
    app,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await app.close();
      } finally {
        open = undefined;
      }
    },
  };
}

export interface RawResult {
  /** Everything the server sent, as latin1 text. */
  text: string;
  /** Status code from the first status line, or null if none arrived. */
  status: number | null;
  /** True if we hit the timeout before the server closed or answered. */
  timedOut: boolean;
}

/**
 * Sends `request` verbatim over a raw TCP socket (so malformed requests reach the
 * server exactly as written) and collects the reply until the server closes the
 * connection, a full response has arrived (`Connection: close` is sent), or the
 * timeout passes.
 */
export function rawRequest(
  port: number,
  request: string,
  options: { timeoutMs?: number; abortAfterBytes?: number } = {},
): Promise<RawResult> {
  const timeoutMs = options.timeoutMs ?? 2000;
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(text);
      resolve({ text, status: match ? Number(match[1]) : null, timedOut });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      text += chunk;
      if (
        options.abortAfterBytes !== undefined &&
        Buffer.byteLength(text, "latin1") >= options.abortAfterBytes
      ) {
        finish(false);
      }
    });
    socket.on("end", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("error", () => finish(false));
    socket.write(request, "latin1");
  });
}

/** Polls until `predicate` returns a truthy value or the timeout passes. */
export async function waitFor<T>(
  predicate: () => T | undefined | false | null,
  timeoutMs = 2000,
  what = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A tiny multipart body with one file field, built by hand so it has no dependency. */
export function multipartBody(): { body: Buffer; contentType: string } {
  const boundary = "----spikeboundary1234";
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      "Content-Type: text/plain",
      "",
      "hello upload",
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Sends a request whose body arrives in later TCP packets: headers first, then the
 * body in `pieces` chunks `gapMs` apart. Resolves with the raw reply once the
 * server has answered (the request carries `Connection: close`).
 */
export function slowBodyRequest(
  port: number,
  head: string,
  body: Buffer,
  options: { pieces?: number; gapMs?: number; timeoutMs?: number } = {},
): Promise<RawResult> {
  const pieces = options.pieces ?? 3;
  const gapMs = options.gapMs ?? 40;
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.setNoDelay(true);
    let text = "";
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(text);
      resolve({ text, status: match ? Number(match[1]) : null, timedOut });
    };
    const timer = setTimeout(() => finish(true), options.timeoutMs ?? 3000);
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("error", () => finish(false));
    socket.write(head, "latin1");
    const size = Math.ceil(body.length / pieces);
    let i = 0;
    const next = () => {
      if (settled || i * size >= body.length) return;
      socket.write(body.subarray(i * size, (i + 1) * size));
      i++;
      setTimeout(next, gapMs);
    };
    setTimeout(next, gapMs);
  });
}
