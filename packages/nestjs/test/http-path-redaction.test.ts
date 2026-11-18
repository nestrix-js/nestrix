// Global state: host provider (bootApp), ALS context manager, W3C propagator.
// Issue #48 / D-97: a secret in a path segment (`/invitations/:token`) reaches no exported span,
// on Express, Fastify and platform-node: not the server span's `url.path`, name or events, and
// not the outgoing request's `url.full` once `http.redactOutgoingPath` covers it. Each test scans
// every exported span's serialised content for the secret.
import http from "node:http";
import {
  Body,
  Controller,
  Get,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
  Param,
  Post,
} from "@nestjs/common";
import {
  type BootedApp,
  bootApp,
  type ReadableSpan,
} from "@nestrix-js/testing";
import { SpanKind } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { type FaultSite, faultInjection } from "../src/http/request-state.js";
import { NestrixModule } from "../src/nestrix.module.js";
import type { NestrixModuleOptions } from "../src/options.js";
import { ADAPTERS, registerHostContext, rootModule } from "./http-fixture.js";
import { type EchoServer, sleep, startEchoServer } from "./outbound-helpers.js";

registerHostContext();

const SECRET = "abc123";

let echo: EchoServer;
beforeAll(async () => {
  echo = await startEchoServer();
});
afterAll(async () => {
  await echo.close();
});

function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

@Controller("invitations")
class InvitationsController {
  /** Calls a downstream service with the token in its path, by fetch and by `node:http`. */
  @Get(":token")
  async accept(@Param("token") token: string): Promise<{ ok: true }> {
    const res = await fetch(`${echo.base}/v1/invitations/${token}/accept`);
    await res.text();
    await httpGet(`${echo.base}/v1/invitations/${token}`);
    return { ok: true };
  }

  @Get(":inviteCode/preview")
  preview(@Param("inviteCode") code: string): { length: number } {
    return { length: code.length };
  }
}

@Controller("items")
class ItemsController {
  @Get(":id")
  one(@Param("id") id: string): { id: string } {
    return { id };
  }
}

@Controller("guarded")
class GuardedController {
  @Get(":token")
  one(): string {
    return "never reached: the middleware answers first";
  }

  @Post(":token")
  create(@Body() body: unknown): unknown {
    return body;
  }
}

/** Answers 401 before routing, like an auth middleware. */
class DenyMiddleware implements NestMiddleware {
  use(
    _req: unknown,
    res: { statusCode: number; end(): void },
    _next: () => void,
  ): void {
    res.statusCode = 401;
    res.end();
  }
}

/** Nestrix, the controllers, and `DenyMiddleware` on `guarded/:token`. */
function middlewareModule(options: NestrixModuleOptions) {
  @Module({
    imports: [NestrixModule.forRoot(options)],
    controllers: [InvitationsController, GuardedController],
  })
  class Root implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(DenyMiddleware).forRoutes("guarded/:token");
    }
  }
  return Root;
}

const BASE: NestrixModuleOptions = {
  export: { otlp: false },
  http: { redactOutgoingPath: ["/v1/invitations/:token"] },
};

let booted: BootedApp | undefined;
afterEach(async () => {
  faultInjection.site = undefined;
  await booted?.close();
  booted = undefined;
});

/** Everything a span carries that an exporter sends, as text. */
function serialise(span: ReadableSpan): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    events: span.events.map((e) => ({
      name: e.name,
      attributes: e.attributes,
    })),
    status: span.status,
    links: span.links.map((l) => l.attributes),
  });
}

async function boot(
  adapter: (typeof ADAPTERS)[number],
  options: NestrixModuleOptions,
  extra: Parameters<typeof rootModule>[0] = [],
): Promise<BootedApp> {
  booted = await bootApp(adapter, {
    module: rootModule(
      [InvitationsController, ItemsController, ...extra],
      options,
      false,
    ),
  });
  return booted;
}

/** Waits until a server span named `name` and at least `clients` client spans are exported. */
async function settle(
  app: BootedApp,
  name: string,
  clients = 0,
): Promise<{ server: ReadableSpan; all: ReadableSpan[] }> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const all = app.spans();
    const server = all.find(
      (s) => s.kind === SpanKind.SERVER && s.name === name,
    );
    const clientCount = all.filter((s) => s.kind === SpanKind.CLIENT).length;
    if (server !== undefined && clientCount >= clients) return { server, all };
    if (Date.now() > deadline) {
      throw new Error(
        `spans not exported; have: ${all.map((s) => s.name).join(", ")}`,
      );
    }
    await sleep(10);
  }
}

function expectNoSecret(all: ReadableSpan[]): void {
  expect(all.length).toBeGreaterThan(0);
  for (const span of all) expect(serialise(span)).not.toContain(SECRET);
}

describe.each(ADAPTERS)("path secrets on %s", (adapter) => {
  it("default (recordPath 'raw'): the :token value is REDACTED in url.path, and outgoing url.full by pattern", async () => {
    const app = await boot(adapter, BASE);
    const res = await fetch(`${app.baseUrl}/invitations/${SECRET}`);
    expect(res.status).toBe(200);
    const { server, all } = await settle(app, "GET /invitations/:token", 2);
    expect(server.attributes["url.path"]).toBe("/invitations/REDACTED");
    expect(server.attributes["http.route"]).toBe("/invitations/:token");
    const fulls = all
      .filter((s) => s.kind === SpanKind.CLIENT)
      .map((s) => s.attributes["url.full"])
      .sort();
    expect(fulls).toEqual([
      `${echo.base}/v1/invitations/REDACTED`,
      `${echo.base}/v1/invitations/REDACTED/accept`,
    ]);
    // The downstream service still got the real path: only the record changes.
    expect(echo.received.map((r) => r.url)).toContain(
      `/v1/invitations/${SECRET}`,
    );
    expectNoSecret(all);
  });

  it("recordPath 'template': url.path is the route template", async () => {
    const app = await boot(adapter, {
      ...BASE,
      http: { ...BASE.http, recordPath: "template" },
    });
    await fetch(`${app.baseUrl}/invitations/${SECRET}`);
    const { server, all } = await settle(app, "GET /invitations/:token", 2);
    expect(server.attributes["url.path"]).toBe("/invitations/:token");
    expectNoSecret(all);
  });

  it("recordPath 'template': a request that matched no route records no url.path", async () => {
    const app = await boot(adapter, {
      ...BASE,
      http: { recordPath: "template" },
    });
    const res = await fetch(`${app.baseUrl}/nowhere/${SECRET}`);
    expect(res.status).toBe(404);
    const { server, all } = await settle(app, "GET");
    expect(server.attributes["url.path"]).toBeUndefined();
    expect(server.attributes["http.route"]).toBeUndefined();
    expectNoSecret(all);
  });

  it("recordPath 'template': ignore.paths still matches the raw path", async () => {
    const app = await boot(adapter, {
      ...BASE,
      ignore: { paths: [`/items/${SECRET}`] },
      http: { recordPath: "template" },
    });
    await fetch(`${app.baseUrl}/items/${SECRET}`);
    await fetch(`${app.baseUrl}/items/other`);
    const { server, all } = await settle(app, "GET /items/:id");
    expect(server.attributes["url.path"]).toBe("/items/:id");
    expect(all.filter((s) => s.kind === SpanKind.SERVER)).toHaveLength(1);
  });

  it("http.redactPathParams adds names, compared case-insensitively", async () => {
    const app = await boot(adapter, {
      ...BASE,
      http: { redactPathParams: ["INVITECODE"] },
    });
    await fetch(`${app.baseUrl}/invitations/${SECRET}/preview`);
    const { server, all } = await settle(
      app,
      "GET /invitations/:inviteCode/preview",
    );
    expect(server.attributes["url.path"]).toBe("/invitations/REDACTED/preview");
    expectNoSecret(all);
  });

  it("raw mode, answered before routing (malformed JSON body, 400): no url.path, no secret", async () => {
    const app = await boot(adapter, BASE, [GuardedController]);
    const res = await fetch(`${app.baseUrl}/guarded/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const { server, all } = await settle(app, "POST");
    expect(server.attributes["http.response.status_code"]).toBe(400);
    expect(server.attributes["url.path"]).toBeUndefined();
    expectNoSecret(all);
  });

  it("raw mode, a middleware answers 401 before routing: no url.path, no secret", async () => {
    booted = await bootApp(adapter, { module: middlewareModule(BASE) });
    const res = await fetch(`${booted.baseUrl}/guarded/${SECRET}`);
    expect(res.status).toBe(401);
    const { server, all } = await settle(booted, "GET");
    expect(server.attributes["http.response.status_code"]).toBe(401);
    expect(server.attributes["url.path"]).toBeUndefined();
    expectNoSecret(all);
  });

  it("raw mode, a 404 that matched no route keeps its raw path", async () => {
    const app = await boot(adapter, BASE);
    const res = await fetch(`${app.baseUrl}/nowhere/${SECRET}`);
    expect(res.status).toBe(404);
    const { server } = await settle(app, "GET");
    expect(server.attributes["url.path"]).toBe(`/nowhere/${SECRET}`);
  });

  it("a parameter not listed keeps its raw value", async () => {
    const app = await boot(adapter, BASE);
    await fetch(`${app.baseUrl}/items/${SECRET}`);
    const { server } = await settle(app, "GET /items/:id");
    expect(server.attributes["url.path"]).toBe(`/items/${SECRET}`);
  });

  it.each<FaultSite>(["url-path", "close-listener"])(
    "a fault at %s fails closed: the raw path is not exported and the request succeeds",
    async (site) => {
      resetDiagnosticsForTests();
      const app = await boot(adapter, BASE);
      faultInjection.site = site;
      const res = await fetch(`${app.baseUrl}/invitations/${SECRET}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const deadline = Date.now() + 3000;
      let server: ReadableSpan | undefined;
      while (server === undefined && Date.now() < deadline) {
        server = app.spans().find((s) => s.kind === SpanKind.SERVER);
        if (server === undefined) await sleep(10);
      }
      expect(server).toBeDefined();
      faultInjection.site = undefined;
      expectNoSecret(app.spans());
      const counted = [...getFailureCounts().keys()];
      expect(counted).toContain(
        site === "url-path" ? "http.url-path" : "http.close-listener",
      );
    },
  );
});
