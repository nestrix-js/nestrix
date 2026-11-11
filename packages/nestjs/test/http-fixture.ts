// Shared fixture for the HTTP server span tests: test controllers, a root-module builder and
// raw-socket helpers. Not a test file itself.
import "reflect-metadata";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ArgumentsHost,
  Body,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  Inject,
  Module,
  Param,
  ParseIntPipe,
  Post,
  type Type,
  UseFilters,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { BootedApp, ReadableSpan } from "@nestrix/testing";
import { context, propagation, SpanKind } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AppModule } from "express-esm/app.module";
import { NestrixModule } from "../src/nestrix.module.js";
import type { NestrixModuleOptions } from "../src/options.js";
import { withSpan } from "../src/span.js";

/**
 * `bootApp` registers a host tracer provider only. A host that wants parented spans also
 * registers a context manager and a propagator; the tests do so, as such a host would.
 */
export function registerHostContext(): void {
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

export const ADAPTERS = ["express", "fastify", "node"] as const;

/** Turns any exception into a 200 through the adapter, so it works on all three. */
@Catch()
export class ToOkFilter implements ExceptionFilter {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}
  catch(_exception: unknown, args: ArgumentsHost): void {
    this.host.httpAdapter.reply(
      args.switchToHttp().getResponse(),
      { handled: true },
      200,
    );
  }
}

export const BIG_BODY_BYTES = 16 * 1024 * 1024;

@Controller("t")
export class TestController {
  @Get("ignored")
  ignored(): string {
    return "ignored";
  }

  @Get("slow")
  async slow(): Promise<string> {
    await sleep(400);
    return "slow";
  }

  /** One large write: the app finishes the response before the client can read it. */
  @Get("big")
  big(): string {
    return "a".repeat(BIG_BODY_BYTES);
  }

  @Get("filtered")
  @UseFilters(ToOkFilter)
  filtered(): never {
    throw new Error("turned into a 200");
  }

  @Get("parse/:n")
  parse(@Param("n", ParseIntPipe) n: number): { n: number } {
    return { n };
  }

  @Get("thrown-string")
  thrownString(): never {
    throw "a plain string";
  }

  /** Answers without reading the request body. */
  @Post("sink/:c")
  sink(): string {
    return "ok";
  }

  @Post("child")
  child(@Body() body: unknown): unknown {
    return withSpan("handler.child", () => body);
  }
}

@Controller({ path: "ver", version: "1" })
export class V1Controller {
  @Get(":id")
  one(@Param("id") id: string): string {
    return `v1:${id}`;
  }
}

@Controller({ path: "ver", version: "2" })
export class V2Controller {
  @Get(":id")
  two(@Param("id") id: string): string {
    return `v2:${id}`;
  }
}

@Controller({ path: "admin", host: "admin.example.com" })
export class HostController {
  @Get()
  admin(): string {
    return "admin";
  }
}

export const DEFAULT_TEST_OPTIONS: NestrixModuleOptions = {
  export: { otlp: false },
  ignore: { paths: ["/t/ignored"] },
  http: { requestHeaders: ["x-extra"] },
};

/** A root module: Nestrix plus the given controllers (and the fixture `AppModule` unless `appModule: false`). */
export function rootModule(
  controllers: Type[],
  options: NestrixModuleOptions = DEFAULT_TEST_OPTIONS,
  appModule = true,
): Type {
  @Module({
    imports: [
      ...(appModule ? [AppModule] : []),
      NestrixModule.forRoot(options),
    ],
    controllers,
  })
  class Root {}
  return Root;
}

/** Server spans from `booted` whose `url.path` is `path`. */
export function serverSpans(booted: BootedApp, path: string): ReadableSpan[] {
  return booted
    .spans()
    .filter(
      (s) => s.kind === SpanKind.SERVER && s.attributes["url.path"] === path,
    );
}

/** Waits for the single server span of `path`. */
export async function serverSpan(
  booted: BootedApp,
  path: string,
  timeoutMs = 3000,
): Promise<ReadableSpan> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = serverSpans(booted, path);
    if (found.length > 0) return found[found.length - 1] as ReadableSpan;
    if (Date.now() > deadline) {
      throw new Error(
        `no server span for ${path}; have: ${booted
          .spans()
          .map((s) => `${s.name} ${String(s.attributes["url.path"])}`)
          .join(", ")}`,
      );
    }
    await sleep(10);
  }
}

export interface RawOptions {
  headers?: Record<string, string>;
  /** Destroy the socket as soon as the first bytes of the response arrive. */
  destroyOnFirstData?: boolean;
  /** Destroy the socket after this many milliseconds. */
  destroyAfterMs?: number;
}

/** Sends one request over a raw socket and resolves when the socket closes. */
export function rawRequest(
  baseUrl: string,
  path: string,
  options: RawOptions = {},
): Promise<string> {
  const { port } = new URL(baseUrl);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1");
    let received = "";
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (options.destroyOnFirstData) socket.destroy();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(received);
    });
    const headers = {
      host: "127.0.0.1",
      connection: "close",
      ...options.headers,
    };
    socket.write(
      `GET ${path} HTTP/1.1\r\n${Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("")}\r\n`,
    );
    if (options.destroyAfterMs !== undefined) {
      setTimeout(() => socket.destroy(), options.destroyAfterMs);
    }
  });
}

export interface ExchangeOptions {
  /** Half-close (send FIN) right after writing the payload. */
  endAfterWrite?: boolean;
  /** Destroy the socket after this many milliseconds (default 300). */
  closeAfterMs?: number;
}

/** Writes raw payload pieces to a fresh socket; resolves with everything received when it closes. */
export function rawExchange(
  baseUrl: string,
  payload: string | Buffer | (string | Buffer)[],
  options: ExchangeOptions = {},
): Promise<string> {
  const { port } = new URL(baseUrl);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
    });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(received));
    for (const piece of ([] as (string | Buffer)[]).concat(payload))
      socket.write(piece);
    if (options.endAfterWrite) socket.end();
    setTimeout(() => socket.destroy(), options.closeAfterMs ?? 300);
  });
}
