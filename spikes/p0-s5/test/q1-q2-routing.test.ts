import "reflect-metadata";
import { VersioningType } from "@nestjs/common";
import { type AdapterName, bootApp } from "@nestrix/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { blobGz, probe, resetProbe } from "../src/dashboard.js";
import {
  CountingFilter,
  CountPipe,
  hostModule,
  hostSeen,
  RejectAllGuard,
  resetHostSeen,
  TagInterceptor,
} from "../src/host.js";
import { get, getJson, note } from "./helpers.js";

const adapters: AdapterName[] = ["express", "fastify", "node"];

beforeEach(() => {
  resetProbe();
  resetHostSeen();
});

const setups = {
  "no prefix": { configure: undefined, hello: "/hello" },
  "global prefix": {
    configure: (app: { setGlobalPrefix: (p: string) => unknown }) =>
      app.setGlobalPrefix("api"),
    hello: "/api/hello",
  },
  "URI versioning": {
    configure: (app: { enableVersioning: (o: unknown) => unknown }) =>
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" }),
    hello: "/v1/hello",
  },
  "prefix + URI versioning": {
    configure: (app: {
      setGlobalPrefix: (p: string) => unknown;
      enableVersioning: (o: unknown) => unknown;
    }) => {
      app.setGlobalPrefix("api");
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    },
    hello: "/api/v1/hello",
  },
} as const;

describe.each(adapters)("Q1 reachability (%s)", (adapter) => {
  for (const [name, setup] of Object.entries(setups)) {
    it(`JSON and asset routes answer at /_nestrix with ${name}`, async () => {
      const booted = await bootApp(adapter, {
        module: hostModule(),
        // biome-ignore lint/suspicious/noExplicitAny: test glue
        configure: setup.configure as any,
      });
      try {
        // Host route is where the setup says (sanity check of the setup itself).
        expect((await get(`${booted.baseUrl}${setup.hello}`)).status).toBe(200);
        const json = await getJson(`${booted.baseUrl}/_nestrix/api/whoami`);
        expect(json.status).toBe(200);
        expect(json.json).toMatchObject({ ok: true });
        const html = await get(`${booted.baseUrl}/_nestrix/index.html`);
        expect(html.status).toBe(200);
        // Byte equality per write strategy is Q6; the default "adapter" strategy
        // JSON-encodes Buffers on Express.
        expect(html.body.length).toBeGreaterThan(0);
        const blob = await get(`${booted.baseUrl}/_nestrix/assets/blob.bin`, {
          "accept-encoding": "gzip",
        });
        expect(blob.status).toBe(200);
        expect(blob.headers["content-encoding"]).toBe("gzip");
        // The prefix/version does not apply to them: not reachable under it.
        if (setup.hello !== "/hello") {
          const prefixed = setup.hello.replace(
            "/hello",
            "/_nestrix/api/whoami",
          );
          expect((await get(`${booted.baseUrl}${prefixed}`)).status).toBe(404);
        }
        expect(probe.registrationErrors).toEqual([]);
        expect(probe.handlerErrors).toEqual([]);
      } finally {
        await booted.close();
      }
    });
  }
  // blobGz is used so the import is not dead in this file
  expect(blobGz.length).toBeGreaterThan(0);
});

describe.each(adapters)("Q2 host global enhancers (%s)", (adapter) => {
  it("APP_GUARD/APP_INTERCEPTOR/APP_PIPE/APP_FILTER do not run for the dashboard routes", async () => {
    const booted = await bootApp(adapter, {
      module: hostModule({ enhancers: true }),
    });
    try {
      // Sanity: the reject-all guard does apply to a host route.
      expect((await get(`${booted.baseUrl}/hello`)).status).toBe(403);
      expect(hostSeen.guard).toBe(1);
      expect(hostSeen.filter).toBe(1); // the 403 ForbiddenException
      resetHostSeen();
      const res = await getJson(`${booted.baseUrl}/_nestrix/api/whoami`);
      expect(res.status).toBe(200);
      expect(
        (await get(`${booted.baseUrl}/_nestrix/assets/blob.bin`)).status,
      ).toBe(200);
      expect(hostSeen).toMatchObject({
        guard: 0,
        interceptor: 0,
        pipe: 0,
        filter: 0,
      });
    } finally {
      await booted.close();
    }
  });

  it("useGlobalGuards/Interceptors/Pipes/Filters do not run for the dashboard routes", async () => {
    const booted = await bootApp(adapter, {
      module: hostModule(),
      configure: (app) => {
        app.useGlobalGuards(new RejectAllGuard());
        app.useGlobalInterceptors(new TagInterceptor());
        app.useGlobalPipes(new CountPipe());
        app.useGlobalFilters(new CountingFilter(app.getHttpAdapter()));
      },
    });
    try {
      expect((await get(`${booted.baseUrl}/hello`)).status).toBe(403);
      resetHostSeen();
      expect(
        (await getJson(`${booted.baseUrl}/_nestrix/api/whoami`)).status,
      ).toBe(200);
      expect(hostSeen).toMatchObject({
        guard: 0,
        interceptor: 0,
        pipe: 0,
        filter: 0,
      });
    } finally {
      await booted.close();
    }
  });

  it("an exception escaping a dashboard handler reaches the host's global filter", async () => {
    const booted = await bootApp(adapter, {
      module: hostModule({ enhancers: true }),
    });
    try {
      const res = await get(`${booted.baseUrl}/_nestrix/api/throws`);
      note(`Q2 ${adapter} throwing handler`, {
        status: res.status,
        hostFilterCalls: hostSeen.filter,
        errors: hostSeen.filterErrors,
        body: res.body.toString().slice(0, 120),
      });
      expect(res.status).toBe(500);
      expect(hostSeen.filter).toBe(1);
      expect(hostSeen.filterErrors).toEqual(["dashboard handler threw"]);
    } finally {
      await booted.close();
    }
  });
});
