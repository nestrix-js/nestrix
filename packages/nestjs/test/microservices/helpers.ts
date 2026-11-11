// Helpers for test/microservices/*.test.ts. Not a test file itself.
//
// Global state: each test file registers, once, a host-owned SDK provider with an in-memory
// exporter, the ALS context manager and the W3C propagator, so Nestrix uses the host SDK and every
// span lands in `exporter`. A file that needs a different provider calls `setupOtel(provider)`.
import "reflect-metadata";
import { createServer } from "node:net";
import {
  type CanActivate,
  Controller,
  Inject,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  type ClientProxy,
  ClientProxyFactory,
  ClientsModule,
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  Transport,
} from "@nestjs/microservices";
import {
  type TracerProvider as ApiTracerProvider,
  context,
  propagation,
  type Span,
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
import { firstValueFrom, lastValueFrom, of, toArray } from "rxjs";
import { NestrixModule } from "../../src/nestrix.module.js";

export const exporter = new InMemorySpanExporter();
export const sdkProvider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});

export function setupOtel(provider: ApiTracerProvider = sdkProvider): void {
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
}

export const HOST = "127.0.0.1";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** What a handler saw: the active span and the metadata its RPC context carried. */
export interface HandlerCall {
  pattern: string;
  spanId: string | undefined;
  traceId: string | undefined;
  metadata: unknown;
}
export const calls: HandlerCall[] = [];

function record(pattern: string, ctx: unknown): void {
  const sc = trace.getActiveSpan()?.spanContext();
  calls.push({
    pattern,
    spanId: sc?.spanId,
    traceId: sc?.traceId,
    metadata: (ctx as { getMetadata?: () => unknown }).getMetadata?.(),
  });
}

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

export const RELAY_CLIENT = "RELAY_CLIENT";

@Controller()
export class Handlers {
  constructor(
    @Inject(RELAY_CLIENT) private readonly relayClient: ClientProxy,
  ) {}

  @MessagePattern("sum")
  sum(@Payload() data: number[], @Ctx() ctx: unknown): number {
    record("sum", ctx);
    return data.reduce((a, b) => a + b, 0);
  }

  @MessagePattern({ cmd: "obj", v: 1 })
  obj(@Ctx() ctx: unknown): string {
    record("obj", ctx);
    return "obj";
  }

  @MessagePattern("stream")
  stream(@Ctx() ctx: unknown) {
    record("stream", ctx);
    return of(1, 2, 3);
  }

  @MessagePattern("fail")
  fail(@Ctx() ctx: unknown): number {
    record("fail", ctx);
    throw new Error("handler failed");
  }

  @MessagePattern("slow")
  async slow(@Ctx() ctx: unknown): Promise<string> {
    record("slow", ctx);
    await new Promise((r) => setTimeout(r, 150));
    return "late";
  }

  @UseGuards(DenyGuard)
  @MessagePattern("guarded")
  guarded(@Ctx() ctx: unknown): string {
    record("guarded", ctx);
    return "never";
  }

  @EventPattern("evt")
  evt(@Payload() _data: unknown, @Ctx() ctx: unknown): void {
    record("evt", ctx);
  }

  /** Calls `sum` through the DI client: nested CLIENT/SERVER spans under this handler's span. */
  @MessagePattern("relay")
  async relay(@Ctx() ctx: unknown): Promise<number> {
    record("relay", ctx);
    return firstValueFrom(this.relayClient.send<number>("sum", [5, 5]));
  }
}

/** A root module: Nestrix (first, as the docs recommend), the handlers and a DI client. */
export function microserviceModule(
  port: number,
  nestrix: unknown = NestrixModule.forRoot({ export: { otlp: false } }),
) {
  @Module({
    imports: [
      nestrix as never,
      ClientsModule.register([
        {
          name: RELAY_CLIENT,
          transport: Transport.TCP,
          options: { host: HOST, port },
        },
      ]),
    ],
    controllers: [Handlers],
  })
  class MicroserviceRoot {}
  return MicroserviceRoot;
}

export async function startMicroservice(
  port: number,
  module = microserviceModule(port),
) {
  const app = await NestFactory.createMicroservice(module, {
    transport: Transport.TCP,
    options: { host: HOST, port },
    logger: false,
  });
  await app.listen();
  return app;
}

export function tcpClient(port: number): ClientProxy {
  return ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: HOST, port },
  });
}

/** Runs `fn` inside a fresh active span named `caller`, which ends when `fn` settles. */
export async function inCaller<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; caller: Span }> {
  const caller = trace.getTracer("test").startSpan("caller");
  try {
    const result = await context.with(
      trace.setSpan(context.active(), caller),
      fn,
    );
    return { result, caller };
  } finally {
    caller.end();
  }
}

export const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
export const named = (name: string): ReadableSpan[] =>
  spans().filter((s) => s.name === name);
export const parentOf = (s: ReadableSpan | undefined) =>
  s?.parentSpanContext?.spanId;
export const idOf = (s: ReadableSpan | undefined) => s?.spanContext().spanId;

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out; spans: ${
          spans()
            .map((s) => s.name)
            .join(", ") || "(none)"
        }`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { firstValueFrom, lastValueFrom, toArray };

export function resetCaptured(): void {
  exporter.reset();
  calls.length = 0;
}
