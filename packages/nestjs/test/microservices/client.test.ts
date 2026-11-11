// Client spans and injection: timing of `send` / `emit`, the outbound rules, and the helper for
// clients made outside DI. TCP in process. Global state: helpers.ts's host-owned SDK provider.
import "reflect-metadata";
import { types } from "node:util";
import type { INestMicroservice } from "@nestjs/common";
import { ClientProxy, type ClientTCP } from "@nestjs/microservices";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  suppressTracing,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { timeout } from "rxjs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  diagnostics,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { injectIntoPacket } from "../../src/microservices/client.js";
import { instrumentClient } from "../../src/microservices/index.js";
import {
  calls,
  firstValueFrom,
  freePort,
  inCaller,
  named,
  resetCaptured,
  setupOtel,
  spans,
  startMicroservice,
  tcpClient,
  wait,
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

const clientSpans = () => spans().filter((s) => s.kind === SpanKind.CLIENT);

describe("send", () => {
  it("is cold: no span and no dispatch until subscribed, then one per subscription", async () => {
    const { caller } = await inCaller(async () => {
      const reply = client.send<number>("sum", [1]);
      await wait(20);
      expect(spans()).toEqual([]);
      expect(calls).toEqual([]);
      await Promise.all([firstValueFrom(reply), firstValueFrom(reply)]);
    });
    await waitFor(() => clientSpans().length === 2 && calls.length === 2);
    for (const s of clientSpans()) {
      expect(s.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
      expect(s.attributes["nestrix.messaging.cancelled"]).toBeUndefined();
    }
  });

  it("a caller that gives up before the reply ends the span as cancelled", async () => {
    const { result } = await inCaller(() =>
      firstValueFrom(client.send("slow", {}).pipe(timeout(30))).catch(
        (e: Error) => e.name,
      ),
    );
    expect(result).toBe("TimeoutError");
    const span = clientSpans()[0];
    expect(span?.attributes["nestrix.messaging.cancelled"]).toBe(true);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    await wait(200); // let the late reply arrive and be dropped
  });

  it("no active span: no client span and nothing injected (the server starts a root span)", async () => {
    expect(await firstValueFrom(client.send("sum", [1, 1]))).toBe(2);
    await waitFor(() => named("tcp sum").length === 1);
    expect(named("tcp sum")[0]?.kind).toBe(SpanKind.SERVER);
    expect(calls[0]?.metadata).toBeUndefined();
  });

  it("under the suppress-tracing key: no client span and nothing injected", async () => {
    const caller = trace.getTracer("test").startSpan("caller");
    const ctx = suppressTracing(trace.setSpan(context.active(), caller));
    await context.with(ctx, () => firstValueFrom(client.send("sum", [1])));
    caller.end();
    await waitFor(() => named("tcp sum").length === 1);
    expect(clientSpans()).toEqual([]);
    expect(calls[0]?.metadata).toBeUndefined();
  });
});

describe("emit", () => {
  it("is hot: dispatched once without a subscriber; the PRODUCER span ends when the event is sent", async () => {
    const { caller } = await inCaller(async () => {
      client.emit("evt", { a: 1 });
    });
    await waitFor(() => calls.length === 1 && named("tcp evt").length === 2);
    await wait(30);
    expect(calls).toHaveLength(1);
    const producer = named("tcp evt").find((s) => s.kind === SpanKind.PRODUCER);
    expect(producer?.parentSpanContext?.spanId).toBe(
      caller.spanContext().spanId,
    );
  });

  it("a subscriber gets the same completion; still one dispatch", async () => {
    await inCaller(() =>
      firstValueFrom(client.emit("evt", {}), { defaultValue: "done" }),
    );
    await waitFor(() => calls.length === 1);
    await wait(30);
    expect(calls).toHaveLength(1);
  });

  it("an emit that fails ends its span with error status, and no uncaught error appears", async () => {
    const dead = instrumentClient(tcpClient(await freePort()));
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      await inCaller(async () => {
        dead.emit("evt", {});
      });
      await waitFor(() => named("tcp evt").length === 1);
      expect(named("tcp evt")[0]?.status.code).toBe(SpanStatusCode.ERROR);
      await wait(50);
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
      await dead.close();
    }
  });
});

describe("instrumentClient", () => {
  it("is idempotent, returns the same object, keeps name and length, uses no Proxy and leaves the prototype alone", async () => {
    const c = tcpClient(port);
    const proto = Object.getPrototypeOf(c);
    expect(instrumentClient(c)).toBe(c);
    const send = c.send;
    instrumentClient(c);
    expect(c.send).toBe(send);
    expect(c.send.name).toBe("send");
    expect(c.send.length).toBe(ClientProxy.prototype.send.length);
    expect(c.emit.name).toBe("emit");
    expect(types.isProxy(c)).toBe(false);
    expect(types.isProxy(c.send)).toBe(false);
    expect(Object.getPrototypeOf(c)).toBe(proto);
    expect(Object.keys(c)).not.toContain("send");
    try {
      await inCaller(() => firstValueFrom(c.send("sum", [1])));
      await waitFor(() => named("tcp sum").length === 2);
      expect(clientSpans()).toHaveLength(1);
    } finally {
      await c.close();
    }
  });

  it("returns anything that is not a client untouched", () => {
    const notClient = { send() {}, emit() {} };
    expect(instrumentClient(notClient)).toBe(notClient);
    expect(Object.getOwnPropertyNames(notClient)).toEqual(["send", "emit"]);
    expect(instrumentClient(null)).toBeNull();
    expect(instrumentClient(42)).toBe(42);
  });

  it("logs once when another tool replaced the dispatch hook (single slot)", async () => {
    resetDiagnosticsForTests();
    const logOnce = vi.spyOn(diagnostics, "logOnce");
    const c = instrumentClient(tcpClient(port)) as ClientTCP;
    c.setOnDispatchHook(() => undefined); // another tool takes the slot
    try {
      await inCaller(() => firstValueFrom(c.send("sum", [1])));
      await inCaller(() => firstValueFrom(c.send("sum", [1])));
      const keys = logOnce.mock.calls.map((a) => a[0]);
      expect(
        keys.filter((k) => k === "microservices.foreign-dispatch-hook"),
      ).toHaveLength(2);
      expect(String(logOnce.mock.calls.at(-1)?.[1])).toMatch(
        /another tool replaced it with setOnDispatchHook/,
      );
    } finally {
      logOnce.mockRestore();
      await c.close();
    }
  });
});

describe("injectIntoPacket", () => {
  const withSpan = <T>(fn: () => T): T => {
    const span = trace.getTracer("test").startSpan("caller");
    try {
      return context.with(trace.setSpan(context.active(), span), fn);
    } finally {
      span.end();
    }
  };

  it("adds traceparent and keeps what is there", () => {
    const packet: { pattern: string; metadata?: unknown } = {
      pattern: "p",
      metadata: { "x-tenant": "a" },
    };
    withSpan(() => injectIntoPacket(packet));
    expect(packet.metadata).toEqual({
      "x-tenant": "a",
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
    });
  });

  it("adds nothing beside an existing traceparent, and never replaces the object then", () => {
    const metadata = { traceparent: "00-1-2-01" };
    const packet = { pattern: "p", metadata };
    withSpan(() => injectIntoPacket(packet));
    expect(packet.metadata).toBe(metadata);
    expect(metadata).toEqual({ traceparent: "00-1-2-01" });
  });

  it("skips a value with a line break (NATS would fail the call) and adds the rest", () => {
    propagation.disable();
    propagation.setGlobalPropagator({
      inject(_ctx, carrier, setter) {
        setter.set(carrier, "x-bad", "a\r\nb");
        setter.set(carrier, "x-good", "ok");
      },
      extract: (ctx) => ctx,
      fields: () => ["x-bad", "x-good"],
    });
    try {
      const packet: { pattern: string; metadata?: unknown } = { pattern: "p" };
      withSpan(() => injectIntoPacket(packet));
      expect(packet.metadata).toEqual({ "x-good": "ok" });
    } finally {
      propagation.disable();
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    }
  });

  it("does nothing without an active span", () => {
    const packet: { pattern: string; metadata?: unknown } = { pattern: "p" };
    injectIntoPacket(packet);
    expect(packet.metadata).toBeUndefined();
  });
});
