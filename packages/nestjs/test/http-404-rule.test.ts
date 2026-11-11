// Global state: host provider (bootApp), ALS context manager, W3C propagator.
// Shows where the 404 rule (architecture §4.2) actually does work: how many times the route
// hook fires for a request that ends in 404 because no version or host accepted it. Where it
// fires, only the rule keeps the route off the span (http-server.test.ts asserts the span).
import { VersioningType } from "@nestjs/common";
import { type BootedApp, bootApp } from "@nestrix/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpServerInstrumentation } from "../src/http/server.js";
import {
  ADAPTERS,
  HostController,
  rawRequest,
  registerHostContext,
  rootModule,
  serverSpan,
  V1Controller,
  V2Controller,
} from "./http-fixture.js";

registerHostContext();

const routeCalls: string[] = [];
const original = HttpServerInstrumentation.prototype.routeHook;
vi.spyOn(HttpServerInstrumentation.prototype, "routeHook").mockImplementation(
  function (this: HttpServerInstrumentation, previous: unknown) {
    const hook = original.call(this, previous);
    return (method: unknown, path: string) => {
      routeCalls.push(path);
      hook(method, path);
    };
  },
);

let booted: BootedApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const VERSIONING = {
  header: { type: VersioningType.HEADER, header: "x-api-version" },
  "media type": { type: VersioningType.MEDIA_TYPE, key: "v=" },
  custom: { type: VersioningType.CUSTOM, extractor: () => "" },
} as const;

// Observed on Nest 12.4.2: Express and platform-node try each handler, so the hook fires once per
// version; Fastify resolves versions as a router constraint and fires nothing.
const EXPECTED_VERSION_CALLS = { express: 2, fastify: 0, node: 2 } as const;

describe.each(ADAPTERS)("404 rule on %s", (adapter) => {
  it.each(Object.keys(VERSIONING) as (keyof typeof VERSIONING)[])(
    "%s versioning, no version accepted",
    async (kind) => {
      booted = await bootApp(adapter, {
        module: rootModule([V1Controller, V2Controller], undefined, false),
        configure: (app) => app.enableVersioning(VERSIONING[kind]),
      });
      routeCalls.length = 0;
      const res = await fetch(`${booted.baseUrl}/ver/x`, {
        headers: kind === "media type" ? { accept: "application/json" } : {},
      });
      expect(res.status).toBe(404);
      const span = await serverSpan(booted, "/ver/x");
      expect(routeCalls).toEqual(
        Array(EXPECTED_VERSION_CALLS[adapter]).fill("/ver/:id"),
      );
      expect(span.name).toBe("GET");
      expect(span.attributes["http.route"]).toBeUndefined();
    },
  );

  it("host filter declines: the hook fires once on every adapter", async () => {
    booted = await bootApp(adapter, {
      module: rootModule([HostController], undefined, false),
    });
    routeCalls.length = 0;
    const raw = await rawRequest(booted.baseUrl, "/admin", {
      headers: { host: "other.example.com" },
    });
    expect(raw.split(" ")[1]).toBe("404");
    const span = await serverSpan(booted, "/admin");
    expect(routeCalls).toEqual(["/admin"]);
    expect(span.name).toBe("GET");
    expect(span.attributes["http.route"]).toBeUndefined();
  });
});
