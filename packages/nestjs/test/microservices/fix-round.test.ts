// P4-01 fix round: a host dispatch hook is kept, a null emit is an error span, a disabled app in a
// process with an enabled one is not traced on the server side. TCP in process.
import "reflect-metadata";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diagnostics,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { instrumentClient } from "../../src/microservices/index.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  calls,
  firstValueFrom,
  freePort,
  inCaller,
  microserviceModule,
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
afterEach(() => {
  resetCaptured();
  resetDiagnosticsForTests();
});

describe("a host dispatch hook already set", () => {
  it("is kept: host metadata still goes out, one warning, client spans still appear", async () => {
    const port = await freePort();
    const app = await startMicroservice(port);
    const client = tcpClient(port);
    client.setOnDispatchHook((packet) => {
      packet.metadata = {
        ...(packet.metadata as object),
        authorization: "Bearer x",
      };
    });
    const logOnce = vi.spyOn(diagnostics, "logOnce");
    try {
      instrumentClient(client);
      const { caller } = await inCaller(() =>
        firstValueFrom(client.send<number>("sum", [1, 2])),
      );
      await waitFor(
        () =>
          calls.length === 1 &&
          spans().filter((s) => s.kind === SpanKind.CLIENT).length === 1,
      );
      const metadata = calls[0]?.metadata as Record<string, unknown>;
      expect(metadata.authorization).toBe("Bearer x");
      expect(metadata.traceparent).toBeUndefined();
      const clientSpan = spans().find((s) => s.kind === SpanKind.CLIENT);
      expect(clientSpan?.parentSpanContext?.spanId).toBe(
        caller.spanContext().spanId,
      );
      const warnings = logOnce.mock.calls.filter((a) =>
        String(a[1]).includes("a dispatch hook is already set"),
      );
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[1])).toBe(
        "a dispatch hook is already set on ClientTCP; Nestrix keeps it and does not inject trace context for this client",
      );
    } finally {
      logOnce.mockRestore();
      await client.close();
      await app.close();
    }
  });
});

describe("emit with a null pattern or data", () => {
  it("ends the PRODUCER span with error status and InvalidMessageException, and returns Nest's result", async () => {
    const port = await freePort();
    const app = await startMicroservice(port);
    const client = instrumentClient(tcpClient(port));
    try {
      await inCaller(async () => {
        const result = client.emit("evt", undefined);
        await expect(firstValueFrom(result)).rejects.toThrow();
        const other = client.emit(null as never, {});
        await expect(firstValueFrom(other)).rejects.toThrow();
      });
      const producers = spans().filter((s) => s.kind === SpanKind.PRODUCER);
      expect(producers).toHaveLength(2);
      for (const span of producers) {
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        const event = span.events.find((e) => e.name === "exception");
        expect(event?.attributes?.["exception.type"]).toBe(
          "InvalidMessageException",
        );
      }
      await wait(30);
      expect(calls).toEqual([]);
    } finally {
      await client.close();
      await app.close();
    }
  });
});

describe("two apps in one process, one disabled", () => {
  it("traces handlers of the enabled app only", async () => {
    const onPort = await freePort();
    const offPort = await freePort();
    const on = await startMicroservice(onPort);
    const off = await startMicroservice(
      offPort,
      microserviceModule(
        offPort,
        NestrixModule.forRootAsync({ useFactory: () => ({ enabled: false }) }),
      ),
    );
    const plainOff = tcpClient(offPort);
    const plainOn = tcpClient(onPort);
    try {
      await firstValueFrom(plainOff.send<number>("sum", [1, 2]));
      await wait(50);
      expect(calls).toHaveLength(1);
      expect(spans()).toEqual([]);

      await firstValueFrom(plainOn.send<number>("sum", [1, 2]));
      await waitFor(() => named("tcp sum").length === 1);
      expect(named("tcp sum")[0]?.kind).toBe(SpanKind.SERVER);
    } finally {
      await plainOff.close();
      await plainOn.close();
      await off.close();
      await on.close();
    }
  });
});
