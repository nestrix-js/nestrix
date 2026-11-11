// A hybrid app (Express + a TCP microservice in one process): one HTTP request -> send and emit
// through a DI client -> handlers, as one trace. Covers the three ways to connect the microservice
// (spike P4-S1 Q2). Global state: @nestrix/testing's host provider, plus the ALS context manager
// and W3C propagator registered here.
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
  Transport,
} from "@nestjs/microservices";
import { type BootedApp, bootApp } from "@nestrix/testing";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterEach, describe, expect, it } from "vitest";
import { nestrixPreRequestHook } from "../../src/microservices/index.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  calls,
  firstValueFrom,
  freePort,
  Handlers,
  HOST,
  RELAY_CLIENT,
} from "./helpers.js";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

@Controller()
class HttpController {
  constructor(@Inject(RELAY_CLIENT) private readonly client: ClientProxy) {}

  @Get("call")
  async call(): Promise<{ sum: number }> {
    this.client.emit("evt", { from: "http" });
    return {
      sum: await firstValueFrom(this.client.send<number>("sum", [20, 22])),
    };
  }

  @Get("guarded")
  async guarded(): Promise<string> {
    return firstValueFrom(this.client.send<string>("guarded", {})).catch(
      () => "rejected",
    );
  }
}

function hybridModule(port: number) {
  @Module({
    imports: [
      NestrixModule.forRoot({ export: { otlp: false } }),
      ClientsModule.register([
        {
          name: RELAY_CLIENT,
          transport: Transport.TCP,
          options: { host: HOST, port },
        },
      ]),
    ],
    controllers: [HttpController, Handlers],
  })
  class HybridRoot {}
  return HybridRoot;
}

type Variant = "default" | "preRequestHook" | "inheritAppConfig+preRequestHook";

async function boot(variant: Variant): Promise<BootedApp> {
  const port = await freePort();
  return bootApp("express", {
    module: hybridModule(port),
    configure: async (app: INestApplication) => {
      const microservice = app.connectMicroservice(
        { transport: Transport.TCP, options: { host: HOST, port } },
        {
          inheritAppConfig: variant.startsWith("inheritAppConfig"),
          deferInitialization: variant !== "default",
        },
      );
      if (variant !== "default")
        microservice.registerPreRequestHook(nestrixPreRequestHook);
      await app.startAllMicroservices();
    },
  });
}

let booted: BootedApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  calls.length = 0;
});

async function waitForSpans(b: BootedApp, count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (b.spans().length < count) {
    if (Date.now() > deadline)
      throw new Error(
        `spans: ${b
          .spans()
          .map((s) => `${s.name}/${s.kind}`)
          .join(", ")}`,
      );
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("hybrid app", () => {
  it("with the pre-request hook: HTTP -> CLIENT -> SERVER and PRODUCER -> CONSUMER in one trace", async () => {
    booted = await boot("preRequestHook");
    const res = await fetch(`${booted.baseUrl}/call`);
    expect(await res.json()).toEqual({ sum: 42 });
    await waitForSpans(booted, 5);
    const all = booted.spans();
    const by = (name: string, kind: SpanKind) =>
      all.find((s) => s.name === name && s.kind === kind);
    const http = by("GET /call", SpanKind.SERVER);
    const client = by("tcp sum", SpanKind.CLIENT);
    const server = by("tcp sum", SpanKind.SERVER);
    const producer = by("tcp evt", SpanKind.PRODUCER);
    const consumer = by("tcp evt", SpanKind.CONSUMER);
    expect(new Set(all.map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(client?.parentSpanContext?.spanId).toBe(http?.spanContext().spanId);
    expect(server?.parentSpanContext?.spanId).toBe(
      client?.spanContext().spanId,
    );
    expect(producer?.parentSpanContext?.spanId).toBe(
      http?.spanContext().spanId,
    );
    expect(consumer?.parentSpanContext?.spanId).toBe(
      producer?.spanContext().spanId,
    );
    expect(calls.find((c) => c.pattern === "sum")?.spanId).toBe(
      server?.spanContext().spanId,
    );
  });

  it("with the pre-request hook, a message a guard rejects still gets a SERVER span, with error status", async () => {
    booted = await boot("preRequestHook");
    const res = await fetch(`${booted.baseUrl}/guarded`);
    expect(await res.text()).toBe("rejected");
    await waitForSpans(booted, 3);
    const server = booted
      .spans()
      .find((s) => s.name === "tcp guarded" && s.kind === SpanKind.SERVER);
    expect(server?.status.code).toBe(SpanStatusCode.ERROR);
    expect(calls).toEqual([]);
  });

  it("default connectMicroservice: the global interceptor does not reach the handlers (no handler spans)", async () => {
    booted = await boot("default");
    const res = await fetch(`${booted.baseUrl}/call`);
    expect(await res.json()).toEqual({ sum: 42 });
    await waitForSpans(booted, 3);
    await new Promise((r) => setTimeout(r, 50));
    const kinds = booted.spans().map((s) => `${s.name}/${SpanKind[s.kind]}`);
    expect(kinds.sort()).toEqual([
      "GET /call/SERVER",
      "tcp evt/PRODUCER",
      "tcp sum/CLIENT",
    ]);
    // The trace context did arrive; nothing reads it, so spans a user starts there are roots.
    expect(calls.find((c) => c.pattern === "sum")?.metadata).toHaveProperty(
      "traceparent",
    );
    expect(calls.find((c) => c.pattern === "sum")?.spanId).toBeUndefined();
  });

  it("inheritAppConfig plus the hook: the interceptor and the hook run, each message is traced once", async () => {
    booted = await boot("inheritAppConfig+preRequestHook");
    const res = await fetch(`${booted.baseUrl}/call`);
    expect(await res.json()).toEqual({ sum: 42 });
    await waitForSpans(booted, 5);
    await new Promise((r) => setTimeout(r, 50));
    const kinds = booted.spans().map((s) => `${s.name}/${SpanKind[s.kind]}`);
    expect(kinds.sort()).toEqual([
      "GET /call/SERVER",
      "tcp evt/CONSUMER",
      "tcp evt/PRODUCER",
      "tcp sum/CLIENT",
      "tcp sum/SERVER",
    ]);
  });
});
