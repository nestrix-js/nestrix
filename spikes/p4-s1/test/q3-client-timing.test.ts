// Q3: client span timing for send / emit, and whether the dispatch hook runs inside the caller's
// context. Q4: a client made with ClientProxyFactory.create outside DI. TCP, in process.
import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { ModulesContainer, NestFactory } from "@nestjs/core";
import {
  type ClientProxy,
  ClientProxyFactory,
  Transport,
} from "@nestjs/microservices";
import { context, trace } from "@opentelemetry/api";
import { firstValueFrom, lastValueFrom, take, timeout, toArray } from "rxjs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { freePort, handled, ProbeModule, RpcController } from "./fixtures.ts";
import {
  type ClientEvents,
  dispatched,
  exporter,
  reset,
  SpanInterceptor,
  setupOtel,
  tracer,
  wait,
  waitFor,
  wrapClient,
} from "./harness.ts";

beforeAll(setupOtel);

const registryEvents: string[] = [];
@Injectable()
class RegistryProbe {
  constructor(modules: ModulesContainer) {
    modules
      .getRpcTargetRegistry<{ constructor: { name: string } }>()
      .subscribe((server) => {
        registryEvents.push(`target:${server.constructor.name}`);
        (
          server as unknown as {
            setOnProcessingStartHook(
              h: (t: unknown, c: unknown, d: () => Promise<unknown>) => void,
            ): void;
          }
        ).setOnProcessingStartHook((_t, ctx, done) => {
          registryEvents.push(
            `start:${(ctx as object).constructor.name}:${JSON.stringify((ctx as { getMetadata(): unknown }).getMetadata())}`,
          );
          void done();
        });
      });
  }
}

@Module({
  imports: [ProbeModule.forRoot(SpanInterceptor)],
  controllers: [RpcController],
  providers: [RegistryProbe],
})
class MsRoot {}

let port = 0;
let closeApp: (() => Promise<unknown>) | undefined;
let client: ClientProxy;
const events: ClientEvents = { log: [] };

beforeAll(async () => {
  port = await freePort();
  const app = await NestFactory.createMicroservice(MsRoot, {
    transport: Transport.TCP,
    options: { host: "127.0.0.1", port },
    logger: false,
  });
  await app.listen();
  closeApp = () => app.close();
  // Q4: created outside DI, then wrapped by a helper.
  client = ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: "127.0.0.1", port },
  });
  wrapClient(client as never, events);
  return async () => {
    await client.close();
    await closeApp?.();
  };
});

afterEach(() => {
  reset();
  handled.length = 0;
  events.log.length = 0;
});

describe("Q3 send", () => {
  it("span starts at subscribe, the dispatch hook sees it active, server span is its child", async () => {
    const parent = tracer().startSpan("caller");
    const obs = context.with(trace.setSpan(context.active(), parent), () =>
      client.send("sum", [1, 2]),
    );
    await wait(20);
    expect(dispatched).toHaveLength(0); // cold: nothing dispatched before subscribe
    expect(events.log).toEqual([]);
    const v = await context.with(trace.setSpan(context.active(), parent), () =>
      firstValueFrom(obs),
    );
    parent.end();
    expect(v).toBe(3);
    await waitFor(() => exporter.getFinishedSpans().length >= 3);
    const spans = exporter.getFinishedSpans();
    const clientSpan = spans.find((s) => s.name === "send sum");
    const serverSpan = spans.find((s) => s.name === "rpc sum");
    console.log("send events", events.log, "dispatch", dispatched);
    console.log(
      "spans",
      spans.map((s) => [
        s.name,
        s.spanContext().spanId,
        s.parentSpanContext?.spanId,
        s.attributes.end,
      ]),
    );
    expect(dispatched[0]?.activeSpanId).toBe(clientSpan?.spanContext().spanId);
    expect(serverSpan?.parentSpanContext?.spanId).toBe(
      clientSpan?.spanContext().spanId,
    );
    expect(handled[0]?.activeSpanId).toBe(serverSpan?.spanContext().spanId);
  });

  it("firstValueFrom on a single reply: complete or unsubscribe first?", async () => {
    await firstValueFrom(client.send("sum", [1]));
    console.log("firstValueFrom", events.log);
  });

  it("streamed reply: lastValueFrom vs take(1)", async () => {
    const all = await lastValueFrom(client.send("stream", {}).pipe(toArray()));
    console.log("stream lastValueFrom", all, events.log);
    events.log.length = 0;
    const one = await firstValueFrom(client.send("stream", {}).pipe(take(1)));
    console.log("stream take(1)", one, events.log);
  });

  it("handler error reaches the client span as an error", async () => {
    await expect(firstValueFrom(client.send("fail", 1))).rejects.toBeDefined();
    console.log("fail", events.log);
    expect(events.log.at(-1)).toBe("send:end:error");
  });

  it("caller timeout unsubscribes before the reply", async () => {
    await expect(
      firstValueFrom(client.send("slow", 1).pipe(timeout(50))),
    ).rejects.toBeDefined();
    console.log("timeout", events.log);
    expect(events.log.at(-1)).toBe("send:end:unsubscribe");
  });

  it("two subscriptions are two dispatches and two spans", async () => {
    const obs = client.send("sum", [2]);
    await Promise.all([firstValueFrom(obs), firstValueFrom(obs)]);
    expect(dispatched).toHaveLength(2);
  });
});

describe("Q3 emit", () => {
  it("emit dispatches without any subscriber (hot)", async () => {
    const parent = tracer().startSpan("caller");
    context.with(trace.setSpan(context.active(), parent), () => {
      client.emit("evt", { x: 1 }); // result ignored
    });
    await waitFor(() => handled.some((h) => h.pattern === "evt"));
    parent.end();
    await wait(20);
    const spans = exporter.getFinishedSpans();
    console.log("emit events", events.log, "dispatch", dispatched);
    console.log(
      "spans",
      spans.map((s) => [
        s.name,
        s.kind,
        s.spanContext().spanId,
        s.parentSpanContext?.spanId,
      ]),
    );
    const producer = spans.find((s) => s.name === "emit evt");
    expect(dispatched[0]?.activeSpanId).toBe(producer?.spanContext().spanId);
    const consumer = spans.find((s) => s.name === "rpc evt");
    expect(consumer?.parentSpanContext?.spanId).toBe(
      producer?.spanContext().spanId,
    );
  });

  it("emit to a server that is down: the hot result errors with nobody subscribed", async () => {
    const dead = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: await freePort() },
    });
    const localEvents: ClientEvents = { log: [] };
    wrapClient(dead as never, localEvents);
    const unhandled: unknown[] = [];
    const onErr = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", onErr);
    dead.emit("evt", {});
    await wait(200);
    process.off("uncaughtException", onErr);
    console.log(
      "emit to dead server",
      localEvents.log,
      "uncaught",
      unhandled.length,
    );
    await dead.close();
  });

  it("raw (unwrapped) emit to a dead server with nobody subscribed: baseline", async () => {
    const dead = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: await freePort() },
    });
    const unhandled: unknown[] = [];
    const onErr = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", onErr);
    dead.emit("evt", {});
    await wait(200);
    process.off("uncaughtException", onErr);
    console.log("raw emit to dead server, uncaught", unhandled.length);
    await dead.close();
  });
});

describe("rpc target registry (alternative for hybrid apps)", () => {
  it("emits the Server instance to a provider constructor's subscription; processing hook sees metadata", async () => {
    await firstValueFrom(client.send("sum", [1]));
    console.log("registry", registryEvents);
    expect(registryEvents[0]).toBe("target:ServerTCP");
    expect(registryEvents.some((e) => e.startsWith("start:TcpContext:"))).toBe(
      true,
    );
  });
});
