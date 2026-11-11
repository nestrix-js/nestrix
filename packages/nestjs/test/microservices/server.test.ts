// Handler spans in a microservice-only app (no HTTP adapter), TCP in process.
// Global state: a host-owned SDK provider with an in-memory exporter (helpers.ts).
import "reflect-metadata";
import type { INestMicroservice } from "@nestjs/common";
import { type ClientProxy, Transport } from "@nestjs/microservices";
import { Test } from "@nestjs/testing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getFailureCounts } from "../../src/diagnostics.js";
import { instrumentClient } from "../../src/microservices/index.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  calls,
  firstValueFrom,
  freePort,
  HOST,
  idOf,
  inCaller,
  lastValueFrom,
  microserviceModule,
  named,
  parentOf,
  resetCaptured,
  setupOtel,
  spans,
  startMicroservice,
  tcpClient,
  toArray,
  waitFor,
} from "./helpers.js";

setupOtel();

let port: number;
let app: INestMicroservice;
let client: ClientProxy;

beforeAll(async () => {
  port = await freePort();
  app = await startMicroservice(port);
  client = instrumentClient(tcpClient(port));
});
afterAll(async () => {
  await client.close();
  await app.close();
});
afterEach(resetCaptured);

describe("@MessagePattern handlers", () => {
  it("a SERVER span named `tcp <pattern>`, child of the caller's CLIENT span, active in the handler", async () => {
    const { result, caller } = await inCaller(() =>
      firstValueFrom(client.send<number>("sum", [1, 2])),
    );
    expect(result).toBe(3);
    await waitFor(() => named("tcp sum").length === 2);
    const clientSpan = named("tcp sum").find((s) => s.kind === SpanKind.CLIENT);
    const serverSpan = named("tcp sum").find((s) => s.kind === SpanKind.SERVER);
    expect(parentOf(clientSpan)).toBe(caller.spanContext().spanId);
    expect(parentOf(serverSpan)).toBe(idOf(clientSpan));
    expect(serverSpan?.spanContext().traceId).toBe(
      caller.spanContext().traceId,
    );
    expect(calls[0]?.spanId).toBe(idOf(serverSpan));
    expect(serverSpan?.attributes).toEqual({
      "messaging.system": "tcp",
      "messaging.destination.name": "sum",
      "messaging.operation.type": "process",
      "code.function.name": "Handlers.sum",
    });
    expect(clientSpan?.attributes).toEqual({
      "messaging.system": "tcp",
      "messaging.destination.name": "sum",
      "messaging.operation.type": "send",
    });
    expect(serverSpan?.status.code).toBe(SpanStatusCode.UNSET);
    // The packet carried the W3C context of the client span.
    expect(calls[0]?.metadata).toEqual({
      traceparent: `00-${caller.spanContext().traceId}-${idOf(clientSpan)}-01`,
    });
  });

  it("an object pattern is named by its JSON with sorted keys", async () => {
    await inCaller(() => firstValueFrom(client.send({ v: 1, cmd: "obj" }, {})));
    await waitFor(() => named('tcp {"cmd":"obj","v":1}').length === 2);
  });

  it("a streamed reply ends the span after the last value", async () => {
    const { result } = await inCaller(() =>
      lastValueFrom(client.send("stream", {}).pipe(toArray())),
    );
    expect(result).toEqual([1, 2, 3]);
    await waitFor(() => named("tcp stream").length === 2);
  });

  it("a handler error is recorded and still reaches the caller unchanged", async () => {
    const { result } = await inCaller(() =>
      firstValueFrom(client.send("fail", {})).catch((e: unknown) => e),
    );
    expect(result).toEqual({
      status: "error",
      message: "Internal server error",
    });
    await waitFor(() => named("tcp fail").length === 2);
    const serverSpan = named("tcp fail").find(
      (s) => s.kind === SpanKind.SERVER,
    );
    expect(serverSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(serverSpan?.attributes["error.type"]).toBe("Error");
    expect(serverSpan?.events.map((e) => e.name)).toEqual(["exception"]);
    expect(serverSpan?.events[0]?.attributes?.["exception.message"]).toBe(
      "handler failed",
    );
    const clientSpan = named("tcp fail").find(
      (s) => s.kind === SpanKind.CLIENT,
    );
    expect(clientSpan?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("a message without trace context starts a root SERVER span", async () => {
    const plain = tcpClient(port); // not instrumented
    try {
      expect(await firstValueFrom(plain.send("sum", [2, 2]))).toBe(4);
    } finally {
      await plain.close();
    }
    await waitFor(() => named("tcp sum").length === 1);
    expect(parentOf(named("tcp sum")[0])).toBeUndefined();
    expect(calls[0]?.metadata).toBeUndefined();
  });

  it("a message a guard rejects gets no handler span from the interceptor (guards run first)", async () => {
    await inCaller(() =>
      firstValueFrom(client.send("guarded", {})).catch(() => undefined),
    );
    await waitFor(() => named("tcp guarded").length === 1);
    expect(named("tcp guarded")[0]?.kind).toBe(SpanKind.CLIENT);
    expect(calls).toEqual([]);
  });

  it("a DI client (ClientsModule) is instrumented: CLIENT and SERVER spans nest under the handler", async () => {
    const { result } = await inCaller(() =>
      firstValueFrom(client.send<number>("relay", {})),
    );
    expect(result).toBe(10);
    await waitFor(() => named("tcp sum").length === 2);
    const relayServer = named("tcp relay").find(
      (s) => s.kind === SpanKind.SERVER,
    );
    const innerClient = named("tcp sum").find(
      (s) => s.kind === SpanKind.CLIENT,
    );
    const innerServer = named("tcp sum").find(
      (s) => s.kind === SpanKind.SERVER,
    );
    expect(parentOf(innerClient)).toBe(idOf(relayServer));
    expect(parentOf(innerServer)).toBe(idOf(innerClient));
  });
});

describe("@EventPattern handlers", () => {
  it("emit: a PRODUCER span and a CONSUMER span, child of it", async () => {
    const { caller } = await inCaller(async () => {
      client.emit("evt", { a: 1 }); // hot: dispatched without a subscriber
    });
    await waitFor(() => named("tcp evt").length === 2);
    const producer = named("tcp evt").find((s) => s.kind === SpanKind.PRODUCER);
    const consumer = named("tcp evt").find((s) => s.kind === SpanKind.CONSUMER);
    expect(parentOf(producer)).toBe(caller.spanContext().spanId);
    expect(parentOf(consumer)).toBe(idOf(producer));
    expect(consumer?.attributes["messaging.operation.type"]).toBe("process");
    expect(consumer?.attributes["code.function.name"]).toBe("Handlers.evt");
    expect(calls.filter((c) => c.pattern === "evt")).toHaveLength(1);
  });
});

describe("other ways to build a microservice", () => {
  it("@nestjs/testing createNestMicroservice: handler spans too", async () => {
    const otherPort = await freePort();
    const moduleRef = await Test.createTestingModule({
      imports: [microserviceModule(otherPort)],
    }).compile();
    const other = moduleRef.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: HOST, port: otherPort },
      logger: false,
    });
    await other.listen();
    const otherClient = instrumentClient(tcpClient(otherPort));
    try {
      await inCaller(() => firstValueFrom(otherClient.send("sum", [1])));
      await waitFor(() => named("tcp sum").length === 2);
    } finally {
      await otherClient.close();
      await other.close();
    }
  });

  it("forRootAsync with enabled: false: no spans, the client and handlers behave the same", async () => {
    const otherPort = await freePort();
    const disabled = await startMicroservice(
      otherPort,
      microserviceModule(
        otherPort,
        NestrixModule.forRootAsync({ useFactory: () => ({ enabled: false }) }),
      ),
    );
    // While `app` (enabled) is still open Nestrix stays active process-wide, so close it first
    // to see the disabled app on its own.
    await client.close();
    await app.close();
    const otherClient = instrumentClient(tcpClient(otherPort));
    try {
      const { result } = await inCaller(() =>
        firstValueFrom(otherClient.send("sum", [3, 4])),
      );
      expect(result).toBe(7);
      otherClient.emit("evt", {});
      await waitFor(() => calls.some((c) => c.pattern === "evt"));
      expect(spans().map((s) => s.name)).toEqual(["caller"]);
      expect(calls[0]?.metadata).toBeUndefined();
    } finally {
      await otherClient.close();
      await disabled.close();
      app = await startMicroservice(port);
      client = instrumentClient(tcpClient(port));
    }
  });

  it("nothing was counted as a Nestrix failure", () => {
    expect(
      [...getFailureCounts().keys()].filter((k) =>
        k.startsWith("microservices"),
      ),
    ).toEqual([]);
  });
});
