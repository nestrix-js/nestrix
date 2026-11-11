import "reflect-metadata";
import fastifyCompress from "@fastify/compress";
import fastifyHelmet from "@fastify/helmet";
import type { INestApplication } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { type AdapterName, bootApp } from "@nestrix/testing";
import compression from "compression";
import helmet from "helmet";
import { beforeEach, describe, expect, it } from "vitest";
import {
  blobGz,
  DASHBOARD_CSP,
  type MountOptions,
  probe,
  resetProbe,
  type WriteStrategy,
} from "../src/dashboard.js";
import { hostModule, hostSeen, resetHostSeen } from "../src/host.js";
import { corsHeaders, get, note, type RawResponse } from "./helpers.js";

const adapters: AdapterName[] = ["express", "fastify", "node"];
const strategies: WriteStrategy[] = ["adapter", "raw"];
const EVIL = "http://evil.example";

beforeEach(() => {
  resetProbe();
  resetHostSeen();
});

type Mw = (req: unknown, res: unknown, next: () => void) => void;
const tagMw =
  (name: string): Mw =>
  (_req, res, next) => {
    const r = res as {
      raw?: { setHeader: (k: string, v: string) => void };
      setHeader: (k: string, v: string) => void;
    };
    (r.raw ?? r).setHeader(name, "1");
    next();
  };

interface Run {
  json: RawResponse;
  big: RawResponse;
  blob: RawResponse;
  hello: RawResponse;
  preflight: RawResponse;
  afterListenError?: string;
}

async function run(
  adapter: AdapterName,
  mount: MountOptions,
  opts: {
    configure?: (app: INestApplication) => unknown;
    afterListen?: (app: INestApplication) => unknown;
    consumerMiddleware?: boolean;
  } = {},
): Promise<Run> {
  const booted = await bootApp(adapter, {
    module: hostModule({ mount, consumerMiddleware: opts.consumerMiddleware }),
    configure: opts.configure,
  });
  try {
    let afterListenError: string | undefined;
    try {
      await opts.afterListen?.(booted.app);
    } catch (e) {
      afterListenError = (e as Error).message;
    }
    const h = { origin: EVIL, "accept-encoding": "gzip" };
    return {
      json: await get(`${booted.baseUrl}/_nestrix/api/whoami`, h),
      big: await get(`${booted.baseUrl}/_nestrix/api/big`, h),
      blob: await get(`${booted.baseUrl}/_nestrix/assets/blob.bin`, h),
      hello: await get(`${booted.baseUrl}/hello`, h),
      preflight: await get(
        `${booted.baseUrl}/_nestrix/api/whoami`,
        {
          origin: EVIL,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
        "OPTIONS",
      ),
      afterListenError,
    };
  } finally {
    await booted.close();
  }
}

describe.each(adapters)("Q4 host middleware (%s)", (adapter) => {
  it("app.use() before listen applies; app.use() after listen does not", async () => {
    const r = await run(
      adapter,
      { when: "init", strategy: "raw" },
      {
        configure: (app) => app.use(tagMw("x-use-before")),
        afterListen: (app) => app.use(tagMw("x-use-after")),
      },
    );
    const obs = {
      dashBefore: r.json.headers["x-use-before"] ?? null,
      dashAfter: r.json.headers["x-use-after"] ?? null,
      helloBefore: r.hello.headers["x-use-before"] ?? null,
      helloAfter: r.hello.headers["x-use-after"] ?? null,
      afterListenError: r.afterListenError ?? null,
    };
    note(`Q4 ${adapter} app.use before/after listen`, obs);
    expect(r.json.status).toBe(200);
    expect(obs.dashBefore).toBe("1");
    expect(obs.helloBefore).toBe("1");
    if (adapter === "fastify") {
      // middie accepts it after listen and runs it for every route.
      expect(obs.afterListenError).toBeNull();
      expect(obs.dashAfter).toBe("1");
      expect(obs.helloAfter).toBe("1");
    } else {
      // Appended after the routes (and the not-found handler): never reached.
      expect(obs.afterListenError).toBeNull();
      expect(obs.dashAfter).toBeNull();
      expect(obs.helloAfter).toBeNull();
    }
  });

  it("MiddlewareConsumer.apply(...).forRoutes('*splat') applies", async () => {
    const r = await run(
      adapter,
      { when: "init", strategy: "raw" },
      { consumerMiddleware: true },
    );
    const obs = {
      dash: r.json.headers["x-host-consumer-middleware"] ?? null,
      hello: r.hello.headers["x-host-consumer-middleware"] ?? null,
      calls: hostSeen.middleware,
    };
    note(`Q4 ${adapter} MiddlewareConsumer forRoutes(*splat)`, obs);
    expect(obs.hello).toBe("1");
    expect(obs.dash).toBe("1");
  });

  for (const strategy of strategies) {
    it(`helmet() and compression() through app.use (${strategy})`, async () => {
      const r = await run(
        adapter,
        { when: "init", strategy },
        {
          configure: (app) => {
            app.use(helmet());
            app.use(compression());
          },
        },
      );
      const obs = {
        dashCsp: r.json.headers["content-security-policy"] ?? null,
        dashHsts: r.json.headers["strict-transport-security"] ?? null,
        dashXcto: r.json.headers["x-content-type-options"] ?? null,
        dashCorp: r.json.headers["cross-origin-resource-policy"] ?? null,
        bigEncoding: r.big.headers["content-encoding"] ?? null,
        blobEncoding: r.blob.headers["content-encoding"] ?? null,
        blobByteExact: r.blob.body.equals(blobGz),
        helloCsp: r.hello.headers["content-security-policy"] ?? null,
      };
      note(`Q4 ${adapter} helmet+compression ${strategy}`, obs);
      // helmet ran (its headers are there) and our own CSP replaced its CSP.
      expect(obs.dashHsts).not.toBeNull();
      expect(obs.dashCsp).toBe(DASHBOARD_CSP);
      // The pre-gzipped asset is not compressed a second time.
      expect(obs.blobEncoding).toBe("gzip");
      if (!(adapter === "express" && strategy === "adapter")) {
        expect(obs.blobByteExact).toBe(true);
      }
      // compression() wraps res.write/end: it gzips our JSON whatever the strategy.
      expect(obs.bigEncoding).toBe("gzip");
    });

    it(`app.useSecurityHeaders() (${strategy})`, async () => {
      const r = await run(
        adapter,
        { when: "init", strategy },
        { configure: (app) => app.useSecurityHeaders() },
      );
      const obs = {
        dashCsp: r.json.headers["content-security-policy"] ?? null,
        dashHsts: r.json.headers["strict-transport-security"] ?? null,
        dashXfo: r.json.headers["x-frame-options"] ?? null,
        helloCsp: r.hello.headers["content-security-policy"] ?? null,
      };
      note(`Q4 ${adapter} useSecurityHeaders ${strategy}`, obs);
      expect(obs.helloCsp).not.toBeNull();
      expect(obs.dashHsts).not.toBeNull();
      expect(obs.dashCsp).toBe(DASHBOARD_CSP);
    });
  }
});

describe("Q4 Fastify plugins (@fastify/helmet, @fastify/compress)", () => {
  for (const strategy of strategies) {
    it(`registered with app.register (${strategy})`, async () => {
      const r = await run(
        "fastify",
        { when: "init", strategy },
        {
          configure: async (app) => {
            const f = app as NestFastifyApplication;
            await f.register(fastifyHelmet);
            await f.register(fastifyCompress, { threshold: 256 });
          },
        },
      );
      const obs = {
        dashCsp: r.json.headers["content-security-policy"] ?? null,
        dashHsts: r.json.headers["strict-transport-security"] ?? null,
        bigEncoding: r.big.headers["content-encoding"] ?? null,
        blobEncoding: r.blob.headers["content-encoding"] ?? null,
        blobByteExact: r.blob.body.equals(blobGz),
        helloEncoding: r.hello.headers["content-encoding"] ?? null,
      };
      note(`Q4 fastify plugins ${strategy}`, obs);
      expect(obs.dashHsts).not.toBeNull();
      expect(obs.dashCsp).toBe(DASHBOARD_CSP);
      expect(obs.blobEncoding).toBe("gzip");
      expect(obs.blobByteExact).toBe(true);
      // @fastify/compress is an onSend hook: reply.send() goes through it,
      // a hijacked reply does not.
      expect(obs.bigEncoding).toBe(strategy === "adapter" ? "gzip" : null);
    });
  }
});

describe("Q5 Fastify: removing CORS headers from reply.raw only", () => {
  for (const strategy of strategies) {
    it(`enableCors(), ${strategy}`, async () => {
      const r = await run(
        "fastify",
        { when: "init", strategy, stripCors: "raw-only" },
        { configure: (app) => app.enableCors() },
      );
      const dash = corsHeaders(r.json.headers);
      note(`Q5 fastify raw-only strip ${strategy}`, dash);
      if (strategy === "adapter") {
        // reply.send() writes the reply's own header map, where @fastify/cors put it.
        expect(dash["access-control-allow-origin"]).toBe("*");
      } else {
        // A hijacked reply sends only what is on reply.raw.
        expect(dash).toEqual({});
      }
    });
  }
});

describe.each(adapters)("Q4/Q5 host CORS (%s)", (adapter) => {
  for (const [label, cors] of [
    ["enableCors()", undefined],
    [
      "enableCors({ origin: true, credentials: true })",
      { origin: true, credentials: true },
    ],
  ] as const) {
    for (const strategy of strategies) {
      for (const stripCors of [false, true]) {
        it(`${label}, ${strategy}, stripCors=${stripCors}`, async () => {
          const r = await run(
            adapter,
            { when: "init", strategy, stripCors },
            { configure: (app) => app.enableCors(cors) },
          );
          const obs = {
            dash: corsHeaders(r.json.headers),
            dashVary: r.json.headers.vary ?? null,
            blob: corsHeaders(r.blob.headers),
            preflightStatus: r.preflight.status,
            preflight: corsHeaders(r.preflight.headers),
            hello: corsHeaders(r.hello.headers),
            handlerErrors: probe.handlerErrors,
          };
          note(`Q5 ${adapter} ${label} ${strategy} strip=${stripCors}`, obs);
          expect(obs.handlerErrors).toEqual([]);
          expect(r.json.status).toBe(200);
          // Host routes get CORS, as configured.
          expect(obs.hello["access-control-allow-origin"]).toBe(
            cors ? EVIL : "*",
          );
          if (!stripCors) {
            // Host CORS leaks onto the dashboard on every adapter.
            expect(obs.dash["access-control-allow-origin"]).toBe(
              cors ? EVIL : "*",
            );
          } else {
            expect(obs.dash).toEqual({});
            expect(obs.blob).toEqual({});
          }
          // The preflight never reaches a dashboard handler: the host answers it.
          expect(obs.preflightStatus).toBe(204);
          expect(obs.preflight["access-control-allow-origin"]).toBe(
            cors ? EVIL : "*",
          );
        });
      }
    }
  }
});
