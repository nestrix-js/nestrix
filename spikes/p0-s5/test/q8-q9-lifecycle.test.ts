import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { type AbstractHttpAdapter, NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { type AdapterName, bootApp } from "@nestrix/testing";
import helmet from "helmet";
import { beforeEach, describe, expect, it } from "vitest";
import { type MountOptions, probe, resetProbe } from "../src/dashboard.js";
import { hostModule, hostSeen, resetHostSeen } from "../src/host.js";
import { corsHeaders, get, note } from "./helpers.js";

const adapters: AdapterName[] = ["express", "fastify", "node"];

beforeEach(() => {
  resetProbe();
  resetHostSeen();
});

describe.each(adapters)("Q8 under @nestjs/testing (%s)", (adapter) => {
  for (const when of ["init", "constructor", "init$"] as const) {
    it(`registration from ${when}`, async () => {
      const booted = await bootApp(adapter, {
        testing: true,
        module: hostModule({ mount: { when, strategy: "raw" } }),
      });
      try {
        const status = (await get(`${booted.baseUrl}/_nestrix/api/whoami`))
          .status;
        const obs = {
          status,
          adapterAtConstruction: probe.adapterAtConstruction,
          adapterAtInit: probe.adapterAtInit,
          registrationErrors: probe.registrationErrors,
          order: probe.order,
        };
        note(`Q8 ${adapter} testing ${when}`, obs);
        expect((await get(`${booted.baseUrl}/hello`)).status).toBe(200);
        // Under Test.createTestingModule().compile(), providers are built before
        // createNestApplication() hands Nest an adapter.
        expect(obs.adapterAtConstruction).toBe(false);
        expect(obs.adapterAtInit).toBe(true);
        if (when === "constructor") {
          expect(obs.registrationErrors).toEqual([
            "constructor: no http adapter",
          ]);
          expect(status).toBe(404);
        } else {
          expect(obs.registrationErrors).toEqual([]);
          expect(status).toBe(200);
        }
      } finally {
        await booted.close();
      }
    });
  }
});

describe("Q8 HttpAdapterHost.init$ under @nestjs/testing fires before the host's routes are registered", () => {
  it("Express: an init$ route is not shadowed by a host catch-all (it was registered first)", async () => {
    const booted = await bootApp("express", {
      testing: true,
      module: hostModule({
        catchAll: true,
        mount: { when: "init$", strategy: "raw" },
      }),
    });
    try {
      const r = await get(`${booted.baseUrl}/_nestrix/api/whoami`);
      expect(probe.adapterAtConstruction).toBe(false);
      expect(r.status).toBe(200);
      expect(r.body.toString()).toMatch(/^\{"ok":true/);
      // ...and the catch-all is live for everything else.
      expect((await get(`${booted.baseUrl}/x`)).body.toString()).toBe(
        "host-catch-all",
      );
    } finally {
      await booted.close();
    }
  });
});

describe("Q8 contexts with no HTTP adapter", () => {
  it("TestingModule.init() without createNestApplication: onModuleInit sees no adapter, nothing throws", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [hostModule({ mount: { when: "init", strategy: "raw" } })],
    }).compile();
    await moduleRef.init();
    note("Q8 testing module without app", {
      adapterAtInit: probe.adapterAtInit,
      errors: probe.registrationErrors,
    });
    expect(probe.adapterAtInit).toBe(false);
    expect(probe.registrationErrors).toEqual(["init: no http adapter"]);
    await moduleRef.close();
  });

  it("NestFactory.createApplicationContext: same", async () => {
    const ctx = await NestFactory.createApplicationContext(
      hostModule({ mount: { when: "init", strategy: "raw" } }),
      { logger: false },
    );
    expect(probe.adapterAtConstruction).toBe(false);
    expect(probe.adapterAtInit).toBe(false);
    expect(probe.registrationErrors).toEqual(["init: no http adapter"]);
    await ctx.close();
  });
});

describe.each(adapters)(
  "Q9 return503OnClosing: the layer initHttpServer() assumes is first (%s)",
  (adapter) => {
    for (const when of ["constructor", "init"] as const) {
      it(`${when}: requests during the shutdown window`, async () => {
        const { ExpressAdapter } = await import("@nestjs/platform-express");
        const { FastifyAdapter } = await import("@nestjs/platform-fastify");
        const { NodeAdapter } = await import("@nestjs/platform-node");
        const instance =
          adapter === "express"
            ? new ExpressAdapter()
            : adapter === "fastify"
              ? new FastifyAdapter()
              : new NodeAdapter();
        const app = await NestFactory.create(
          hostModule({ mount: { when, strategy: "raw" } }),
          instance,
          { logger: false, return503OnClosing: true },
        );
        await app.listen(0, "127.0.0.1");
        try {
          const base = await app.getUrl();
          const url = base.replace("[::1]", "127.0.0.1");
          // What app.close() calls first: the adapter enters its shutting-down state.
          app.getHttpAdapter().beforeClose?.();
          const hello = (await get(`${url}/hello`)).status;
          const dash = (await get(`${url}/_nestrix/api/whoami`)).status;
          note(`Q9 ${adapter} return503OnClosing ${when}`, { hello, dash });
          expect(hello).toBe(503);
          if (when === "constructor" && adapter !== "fastify") {
            // Our route sits ahead of the 503 layer and keeps answering.
            expect(dash).toBe(200);
          } else {
            expect(dash).toBe(503);
          }
        } finally {
          await app.close();
        }
      });
    }
  },
);

describe.each(adapters)(
  "Q9 constructor-time registration under NestFactory (%s)",
  (adapter) => {
    const layers = (app: INestApplication) => {
      // app.getHttpAdapter() is typed HttpServer, which does not declare the hook.
      const http = app.getHttpAdapter() as unknown as AbstractHttpAdapter;
      http.setOnRequestHook((_req: unknown, res: unknown, done: () => void) => {
        try {
          const r = res as {
            raw?: { setHeader: (k: string, v: string) => void };
            setHeader: (k: string, v: string) => void;
          };
          (r.raw ?? r).setHeader("x-request-hook", "1");
        } finally {
          done();
        }
      });
      app.enableCors();
      app.use(helmet());
      app.useSecurityHeaders();
    };

    for (const when of ["constructor", "init$", "init"] as const) {
      it(`${when}: reachable, and which host layers apply`, async () => {
        const mount: MountOptions = { when, strategy: "raw" };
        const booted = await bootApp(adapter, {
          module: hostModule({ mount, consumerMiddleware: true }),
          configure: layers,
        });
        try {
          const dash = await get(`${booted.baseUrl}/_nestrix/api/whoami`, {
            origin: "http://evil.example",
          });
          const hello = await get(`${booted.baseUrl}/hello`, {
            origin: "http://evil.example",
          });
          const obs = {
            status: dash.status,
            adapterAtConstruction: probe.adapterAtConstruction,
            errors: probe.registrationErrors,
            requestHook: dash.headers["x-request-hook"] ?? null,
            cors: corsHeaders(dash.headers),
            helmetHsts: dash.headers["strict-transport-security"] ?? null,
            securityHeadersXfo: dash.headers["x-frame-options"] ?? null,
            consumerMiddleware:
              dash.headers["x-host-consumer-middleware"] ?? null,
            helloStatus: hello.status,
            helloCors: corsHeaders(hello.headers),
            helloXfo: hello.headers["x-frame-options"] ?? null,
          };
          note(`Q9 ${adapter} ${when}`, obs);
          expect(obs.errors).toEqual([]);
          expect(obs.adapterAtConstruction).toBe(true);
          expect(obs.status).toBe(200);
          expect(obs.helloStatus).toBe(200);
          // Nest's request hook wraps the router, so it covers our routes either way.
          expect(obs.requestHook).toBe("1");
          // The host's own routes are unaffected.
          expect(obs.helloCors["access-control-allow-origin"]).toBe("*");
          expect(obs.helloXfo).toBe("SAMEORIGIN");
          if (when !== "init" && adapter !== "fastify") {
            // Registered before main.ts ran enableCors()/use()/useSecurityHeaders(),
            // and before Nest registered module middleware: none of it applies.
            expect(obs.cors).toEqual({});
            expect(obs.helmetHsts).toBeNull();
            expect(obs.securityHeadersXfo).toBeNull();
            expect(obs.consumerMiddleware).toBeNull();
          } else {
            // Fastify runs hooks and middie for every route whatever the order;
            // onModuleInit routes come after all of it on every adapter.
            expect(obs.cors["access-control-allow-origin"]).toBe("*");
            expect(obs.helmetHsts).not.toBeNull();
            expect(obs.securityHeadersXfo).toBe("SAMEORIGIN");
            expect(obs.consumerMiddleware).toBe("1");
          }
          expect(hostSeen.middleware).toBeGreaterThan(0);
        } finally {
          await booted.close();
        }
      });
    }
  },
);
