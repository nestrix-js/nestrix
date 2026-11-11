// Global state: host provider (bootApp), ALS context manager, W3C propagator.
// forRootAsync whose factory returns `enabled: false`: the module's providers exist (the factory
// result is not known when the module is built), but nothing is installed: no HTTP hooks, no
// uncaughtExceptionMonitor, and the interceptor returns Nest's stream unchanged.
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { type BootedApp, bootApp } from "@nestrix-js/testing";
import { SpanKind } from "@opentelemetry/api";
import { AppModule } from "express-esm/app.module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NestrixInterceptor } from "../src/http/interceptor.js";
import { HttpServerInstrumentation } from "../src/http/server.js";
import { NestrixModule } from "../src/nestrix.module.js";
import { ADAPTERS, registerHostContext } from "./http-fixture.js";

registerHostContext();

@Module({
  imports: [
    AppModule,
    NestrixModule.forRootAsync({
      useFactory: async () => ({ enabled: false }),
    }),
  ],
})
class Root {}

let booted: BootedApp | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await booted?.close();
  booted = undefined;
});

describe.each(ADAPTERS)("forRootAsync with enabled: false on %s", (adapter) => {
  it("installs no hooks or process monitor, and the interceptor passes through", async () => {
    const routeHook = vi.spyOn(
      HttpServerInstrumentation.prototype,
      "routeHook",
    );
    const original = NestrixInterceptor.prototype.intercept;
    const pairs: { handled: unknown; returned: unknown }[] = [];
    vi.spyOn(NestrixInterceptor.prototype, "intercept").mockImplementation(
      function (
        this: NestrixInterceptor,
        ctx: ExecutionContext,
        next: CallHandler,
      ) {
        const pair = {
          handled: undefined as unknown,
          returned: undefined as unknown,
        };
        const returned = original.call(this, ctx, {
          handle: () => {
            pair.handled = next.handle();
            return pair.handled as ReturnType<CallHandler["handle"]>;
          },
        });
        pair.returned = returned;
        pairs.push(pair);
        return returned;
      },
    );
    const monitorsBefore = process.listenerCount("uncaughtExceptionMonitor");

    booted = await bootApp(adapter, { module: Root });
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
      monitorsBefore,
    );

    const hello = await fetch(`${booted.baseUrl}/users/3`);
    expect(await hello.json()).toEqual({ id: "3" });
    const boom = await fetch(`${booted.baseUrl}/boom`);
    expect(boom.status).toBe(500);

    expect(routeHook).not.toHaveBeenCalled();
    expect(booted.spans().filter((s) => s.kind === SpanKind.SERVER)).toEqual(
      [],
    );
    expect(pairs).toHaveLength(2); // registered, and called for both requests
    for (const { handled, returned } of pairs) expect(returned).toBe(handled);
  });
});
