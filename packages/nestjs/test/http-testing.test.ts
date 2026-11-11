// Global state: host provider (bootApp), ALS context manager, W3C propagator.
// Under @nestjs/testing the adapter is undefined when NestrixCore is constructed; the hooks are
// installed from HttpAdapterHost.init$ (nest-hooks §1). This file is the regression test the
// nightly latest-12.x job runs for that dependency on init$'s emission timing (P0-S1).
import { type BootedApp, bootApp } from "@nestrix-js/testing";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { faultInjection } from "../src/http/request-state.js";
import {
  ADAPTERS,
  registerHostContext,
  rootModule,
  serverSpan,
  TestController,
} from "./http-fixture.js";

registerHostContext();

let booted: BootedApp | undefined;
beforeEach(() => resetDiagnosticsForTests());
afterEach(async () => {
  faultInjection.site = undefined;
  await booted?.close();
  booted = undefined;
});

describe.each(ADAPTERS)("@nestjs/testing on %s", (adapter) => {
  it("produces server spans with the route template", async () => {
    booted = await bootApp(adapter, {
      testing: true,
      module: rootModule([TestController]),
    });
    await fetch(`${booted.baseUrl}/users/5`);
    const span = await serverSpan(booted, "/users/5");
    expect(span.name).toBe("GET /users/:id");
    expect(span.attributes["http.route"]).toBe("/users/:id");
    expect(span.attributes["code.function.name"]).toBe("AppController.user");

    await fetch(`${booted.baseUrl}/boom`);
    const boom = await serverSpan(booted, "/boom");
    expect(boom.status.code).toBe(SpanStatusCode.ERROR);

    await fetch(`${booted.baseUrl}/missing`);
    expect((await serverSpan(booted, "/missing")).name).toBe("GET");
  });

  it("a fault inside the init$ subscriber does not stop the app, and is counted", async () => {
    faultInjection.site = "init-subscriber";
    booted = await bootApp(adapter, {
      testing: true,
      module: rootModule([]),
    });
    faultInjection.site = undefined;
    const res = await fetch(`${booted.baseUrl}/hello`);
    expect(await res.text()).toBe("hello");
    expect(getFailureCounts().get("http.init-subscriber")).toBe(1);
    // The fault is injected after installing, so the hooks are in place.
    expect((await serverSpan(booted, "/hello")).name).toBe("GET /hello");
  });
});
