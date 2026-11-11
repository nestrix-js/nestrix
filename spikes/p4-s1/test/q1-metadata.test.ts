// Q1: where does dispatch-hook metadata arrive on the server, per transport, and how is it read
// through public APIs? TCP always; brokers when P4S1_BROKERS=1 with the *_PORT variables of
// running containers (docs/spikes/P4-S1.md has the docker commands).
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  type ClientProxy,
  ClientProxyFactory,
  NatsRecordBuilder,
  RmqRecordBuilder,
  Transport,
} from "@nestjs/microservices";
import { context, trace } from "@opentelemetry/api";
import { firstValueFrom } from "rxjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, handled, ProbeModule, RpcController } from "./fixtures.ts";
import {
  dispatched,
  dispatchHook,
  exporter,
  reset,
  SpanInterceptor,
  setupOtel,
  tracer,
  wait,
  waitFor,
} from "./harness.ts";

beforeAll(setupOtel);

@Module({
  imports: [ProbeModule.forRoot(SpanInterceptor)],
  controllers: [RpcController],
})
class MsRoot {}

const env = process.env;
const brokers = env.P4S1_BROKERS === "1";
type Bag = Record<string, unknown>;

interface Case {
  name: string;
  enabled: boolean;
  options: () => Promise<Bag>;
  headers?: (ctx: never) => unknown;
  recordWithHeader?: (data: unknown) => Promise<unknown>;
  setupClient?: (c: ClientProxy) => Promise<void>;
  settleMs?: number;
}

function natsHeaders(ctx: {
  getHeaders(): { keys(): string[]; get(k: string): string } | undefined;
}): unknown {
  const h = ctx.getHeaders();
  return h ? Object.fromEntries(h.keys().map((k) => [k, h.get(k)])) : h;
}

function kafkaHeaders(ctx: { getMessage(): { headers?: Bag } }): unknown {
  const h = ctx.getMessage().headers ?? {};
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => [
      k,
      Buffer.isBuffer(v) ? `Buffer(${v.toString()})` : v,
    ]),
  );
}

const cases: Case[] = [
  {
    name: "tcp",
    enabled: true,
    options: async () => ({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: await freePort() },
    }),
  },
  {
    name: "redis",
    enabled: brokers,
    options: async () => ({
      transport: Transport.REDIS,
      options: { host: "127.0.0.1", port: Number(env.REDIS_PORT) },
    }),
  },
  {
    name: "nats",
    enabled: brokers,
    options: async () => ({
      transport: Transport.NATS,
      options: { servers: [`nats://127.0.0.1:${env.NATS_PORT}`] },
    }),
    headers: natsHeaders as never,
    recordWithHeader: async (data) => {
      const { headers } = await import("@nats-io/transport-node");
      const h = headers();
      h.set("x-probe", "from-record");
      return new NatsRecordBuilder(data).setHeaders(h).build();
    },
  },
  {
    name: "rabbitmq",
    enabled: brokers,
    options: async () => ({
      transport: Transport.RMQ,
      options: {
        urls: [`amqp://127.0.0.1:${env.RMQ_PORT}`],
        queue: `p4s1-${Date.now()}`,
        queueOptions: { durable: true },
      },
    }),
    headers: ((ctx: { getMessage(): { properties: { headers: unknown } } }) =>
      ctx.getMessage().properties.headers) as never,
    recordWithHeader: async (data) =>
      new RmqRecordBuilder(data)
        .setOptions({ headers: { "x-probe": "from-record" } })
        .build(),
  },
  {
    name: "kafka",
    enabled: brokers,
    settleMs: 1500,
    options: async () => ({
      transport: Transport.KAFKA,
      options: {
        client: {
          clientId: `p4s1-${Date.now()}`,
          brokers: [`127.0.0.1:${env.KAFKA_PORT}`],
          logLevel: 0,
        },
        consumer: { groupId: `p4s1-${Date.now()}` },
      },
    }),
    headers: kafkaHeaders as never,
    recordWithHeader: async (data) => ({
      value: data,
      headers: { "x-probe": "from-record" },
    }),
    setupClient: async (c) => {
      (
        c as unknown as { subscribeToResponseOf(p: string): void }
      ).subscribeToResponseOf("sum");
      await c.connect();
    },
  },
  {
    name: "mqtt5",
    enabled: brokers,
    options: async () => ({
      transport: Transport.MQTT,
      options: { url: `mqtt://127.0.0.1:${env.MQTT_PORT}`, protocolVersion: 5 },
    }),
    headers: ((ctx: {
      getPacket(): { properties?: { userProperties?: unknown } };
    }) => ctx.getPacket().properties?.userProperties) as never,
  },
  {
    name: "mqtt3",
    enabled: brokers,
    options: async () => ({
      transport: Transport.MQTT,
      options: { url: `mqtt://127.0.0.1:${env.MQTT_PORT}` },
    }),
    headers: ((ctx: { getPacket(): { properties?: unknown } }) =>
      ctx.getPacket().properties) as never,
  },
];

const results: Bag = {};
afterAll(() => {
  console.log("Q1 RESULTS", JSON.stringify(results, null, 1));
});

function summarise(c: Case) {
  return handled.map((h) => ({
    pattern: h.pattern,
    ctxClass: h.ctxClass,
    getMetadata: h.metadata,
    transportHeaders: c.headers ? c.headers(h.extra as never) : undefined,
    activeTraceId: h.activeTraceId,
  }));
}

for (const c of cases) {
  describe.skipIf(!c.enabled)(`Q1 ${c.name}`, () => {
    it("metadata on send and emit", async () => {
      reset();
      handled.length = 0;
      const opts = await c.options();
      const app = await NestFactory.createMicroservice(MsRoot, {
        ...opts,
        logger: ["error"],
      } as never);
      await app.listen();
      const client = ClientProxyFactory.create(opts as never);
      client.setOnDispatchHook(dispatchHook);
      const out: Bag = {};
      try {
        await c.setupClient?.(client);
        if (c.settleMs) await wait(c.settleMs);
        const caller = tracer().startSpan("caller");
        const inCaller = <T>(fn: () => T): T =>
          context.with(trace.setSpan(context.active(), caller), fn);
        out.sum = await inCaller(() =>
          firstValueFrom(client.send("sum", [1, 2])),
        );
        await inCaller(() => firstValueFrom(client.emit("evt", { a: 1 })));
        caller.end();
        out.callerTraceId = caller.spanContext().traceId;
        await waitFor(() => handled.some((h) => h.pattern === "evt"), 15000);
        await wait(50);
        out.handled = summarise(c);
        out.injected = dispatched.map((d) => d.injected.traceparent);
        out.spans = exporter.getFinishedSpans().map((s) => ({
          name: s.name,
          traceId: s.spanContext().traceId,
          parentSpanId: s.parentSpanContext?.spanId,
        }));
        if (c.recordWithHeader) {
          handled.length = 0;
          const record = await c.recordWithHeader({ a: 2 });
          await firstValueFrom(client.emit("evt", record));
          await waitFor(() => handled.some((h) => h.pattern === "evt"), 15000);
          out.recordHeaderWins = summarise(c)[0];
        }
        expect(Number(out.sum)).toBe(3); // Kafka replies with the string "3"
      } finally {
        results[c.name] = out;
        console.log(`Q1 ${c.name}`, JSON.stringify(out));
        await client.close();
        await app.close();
      }
    }, 60000);
  });
}
