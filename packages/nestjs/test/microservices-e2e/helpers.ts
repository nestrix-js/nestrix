// Shared scenario for test/microservices-e2e/<transport>.test.ts (backlog P4-02). Not a test file.
//
// One hybrid app per transport (Express + a microservice on the same broker, connected the way the
// README says: `deferInitialization` plus `nestrixPreRequestHook`). One `GET /call` does a `send`
// and an `emit` through a ClientsModule client; the handlers answer through the real broker.
// Asserted: one trace of five spans, HTTP SERVER -> CLIENT (send) -> SERVER (handler) and
// HTTP SERVER -> PRODUCER (emit) -> CONSUMER (handler), named `<transport> <pattern>`.
import "reflect-metadata";
import {
  Controller,
  Get,
  type INestApplication,
  Inject,
  Module,
} from "@nestjs/common";
import {
  type ClientProxy,
  ClientsModule,
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
} from "@nestjs/microservices";
import { type BootedApp, bootApp } from "@nestrix/testing";
import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { firstValueFrom } from "rxjs";
import { afterAll, describe, expect, inject, it } from "vitest";
import { nestrixPreRequestHook } from "../../src/microservices/index.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import type { BrokerAddress, BrokerKey } from "./brokers.global.js";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

export const CLIENT = "E2E_CLIENT";

interface HandlerCall {
  pattern: string;
  activeSpanId: string | undefined;
}
const calls: HandlerCall[] = [];

@Controller()
class E2eController {
  constructor(@Inject(CLIENT) private readonly client: ClientProxy) {}

  @Get("call")
  async call(): Promise<{ sum: number }> {
    this.client.emit("evt", { from: "http" });
    const sum = await firstValueFrom(this.client.send("sum", [20, 22]));
    return { sum: Number(sum) }; // Kafka replies with a string
  }

  @MessagePattern("sum")
  sum(@Payload() data: number[], @Ctx() _ctx: unknown): number {
    calls.push({
      pattern: "sum",
      activeSpanId: trace.getActiveSpan()?.spanContext().spanId,
    });
    return data.reduce((a, b) => a + b, 0);
  }

  @EventPattern("evt")
  evt(@Payload() _data: unknown, @Ctx() _ctx: unknown): void {
    calls.push({
      pattern: "evt",
      activeSpanId: trace.getActiveSpan()?.spanContext().spanId,
    });
  }
}

export interface TransportCase {
  /** `messaging.system` and the span-name prefix. */
  system: string;
  /** The broker the globalSetup started; absent for TCP, which needs none. */
  broker?: BrokerKey;
  /** Waits until the broker serves requests (and creates what it needs, e.g. Kafka topics). */
  ready(address: BrokerAddress | undefined): Promise<void>;
  /** Client and server options for `address`; `unique` is fresh per run (queue, client ids). */
  options(
    address: BrokerAddress | undefined,
    unique: string,
  ): { client: Record<string, unknown>; server: Record<string, unknown> };
  /** Runs against the DI client once the app is up (Kafka subscribes to the reply topic). */
  prepareClient?(client: ClientProxy): Promise<void>;
}

/** Retries `attempt` until it resolves or `timeoutMs` passes; rethrows the last error. */
export async function waitUntil(
  attempt: () => Promise<unknown>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      await attempt();
      return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `${what} not ready after ${timeoutMs} ms: ${String(last)}`,
      );
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function boot(
  clientOptions: Record<string, unknown>,
  serverOptions: Record<string, unknown>,
  prepareClient: TransportCase["prepareClient"],
): Promise<BootedApp> {
  @Module({
    imports: [
      NestrixModule.forRoot({ export: { otlp: false } }),
      ClientsModule.register([{ name: CLIENT, ...clientOptions } as never]),
    ],
    controllers: [E2eController],
  })
  class E2eRoot {}
  return bootApp("express", {
    module: E2eRoot,
    configure: async (app: INestApplication) => {
      app
        .connectMicroservice(serverOptions as never, {
          deferInitialization: true,
        })
        .registerPreRequestHook(nestrixPreRequestHook);
      await app.startAllMicroservices();
      await prepareClient?.(app.get<ClientProxy>(CLIENT));
    },
  });
}

export function describeTransport(c: TransportCase): void {
  const brokers = inject("brokers");
  const address = c.broker === undefined ? undefined : brokers[c.broker];
  const skip =
    c.broker === undefined
      ? undefined
      : (brokers.skip ?? (address ? undefined : `no ${c.broker} broker`));
  if (skip !== undefined)
    console.log(`[nestrix microservices-e2e] ${c.system} skipped: ${skip}`);

  describe.skipIf(skip !== undefined)(`${c.system} end to end`, () => {
    let booted: BootedApp | undefined;
    afterAll(async () => {
      await booted?.close();
    });

    it("one HTTP request: send and emit are one connected trace across the broker", async () => {
      const started = Date.now();
      await c.ready(address);
      const { client, server } = c.options(
        address,
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      );
      calls.length = 0;
      booted = await boot(client, server, c.prepareClient);

      const res = await fetch(`${booted.baseUrl}/call`);
      expect(await res.json()).toEqual({ sum: 42 });

      const app = booted;
      const deadline = Date.now() + 15_000;
      while (app.spans().length < 5 || calls.length < 2) {
        if (Date.now() > deadline)
          throw new Error(
            `spans: ${app
              .spans()
              .map((s) => `${s.name}/${SpanKind[s.kind]}`)
              .join(", ")}; handler calls: ${calls.length}`,
          );
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 100)); // nothing extra may follow

      const all = app.spans();
      const by = (name: string, kind: SpanKind) =>
        all.filter((s) => s.name === name && s.kind === kind);
      const one = (name: string, kind: SpanKind) => {
        const found = by(name, kind);
        expect(found, `${name}/${SpanKind[kind]}`).toHaveLength(1);
        return found[0] as (typeof all)[number];
      };
      const http = one("GET /call", SpanKind.SERVER);
      const sendClient = one(`${c.system} sum`, SpanKind.CLIENT);
      const sendServer = one(`${c.system} sum`, SpanKind.SERVER);
      const producer = one(`${c.system} evt`, SpanKind.PRODUCER);
      const consumer = one(`${c.system} evt`, SpanKind.CONSUMER);

      expect(all).toHaveLength(5);
      expect(new Set(all.map((s) => s.spanContext().traceId)).size).toBe(1);
      const id = (s: (typeof all)[number]) => s.spanContext().spanId;
      const parent = (s: (typeof all)[number]) => s.parentSpanContext?.spanId;
      expect(parent(http)).toBeUndefined();
      expect(parent(sendClient)).toBe(id(http));
      expect(parent(sendServer)).toBe(id(sendClient));
      expect(parent(producer)).toBe(id(http));
      expect(parent(consumer)).toBe(id(producer));
      for (const s of [sendClient, sendServer, producer, consumer])
        expect(s.attributes["messaging.system"]).toBe(c.system);

      // The handlers ran inside their spans.
      expect(calls.find((x) => x.pattern === "sum")?.activeSpanId).toBe(
        id(sendServer),
      );
      expect(calls.find((x) => x.pattern === "evt")?.activeSpanId).toBe(
        id(consumer),
      );
      console.log(
        `[nestrix microservices-e2e] ${c.system}: ${Date.now() - started} ms`,
      );
    }, 90_000);
  });
}
