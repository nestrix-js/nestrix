import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { ServeStaticModule } from "@nestjs/serve-static";
import { type AdapterName, bootApp } from "@nestrix/testing";
import { dashboardDirectory } from "@nestrix/ui";
import { beforeEach, describe, expect, it } from "vitest";
import { probe, resetProbe } from "../src/dashboard.js";
import { hostModule } from "../src/host.js";
import { get, note } from "./helpers.js";

const adapters: AdapterName[] = ["express", "fastify", "node"];

beforeEach(() => resetProbe());

/** Another module whose onModuleInit adds a plain `use()` middleware. */
@Injectable()
class Interposer implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}
  onModuleInit() {
    probe.order.push("interposer:use");
    this.host.httpAdapter.use(
      (_req: unknown, _res: unknown, next: () => void) => next(),
    );
  }
}
@Module({ providers: [Interposer] })
class InterposerModule {}

const catchAllFor = (adapter: AdapterName) =>
  adapter === "fastify" ? ("fastify" as const) : true;

async function reach(baseUrl: string) {
  const r = await get(`${baseUrl}/_nestrix/api/whoami`);
  return { status: r.status, body: r.body.toString().slice(0, 40) };
}

describe.each(adapters)("Q3 host catch-all route (%s)", (adapter) => {
  it("@Get('*splat') with no prefix", async () => {
    const booted = await bootApp(adapter, {
      module: hostModule({
        catchAll: catchAllFor(adapter),
        mount: { when: "init", strategy: "raw", selfProbe: true },
      }),
    });
    try {
      const r = await reach(booted.baseUrl);
      const self = await probe.selfProbe;
      note(`Q3 ${adapter} catch-all no prefix`, { ...r, selfProbe: self });
      // Sanity: the catch-all is live.
      expect((await get(`${booted.baseUrl}/anything`)).body.toString()).toBe(
        "host-catch-all",
      );
      if (adapter === "express") {
        expect(r.body).toBe("host-catch-all");
        expect(self).toBe("shadowed: status 200");
      } else {
        expect(r.status).toBe(200);
        expect(r.body).toMatch(/^\{"ok":true/);
        expect(self).toBe("reachable");
      }
    } finally {
      await booted.close();
    }
  });

  it("@Get('*splat') under a global prefix does not shadow /_nestrix", async () => {
    const booted = await bootApp(adapter, {
      module: hostModule({
        catchAll: catchAllFor(adapter),
        mount: { when: "init", strategy: "raw", selfProbe: true },
      }),
      configure: (app) => app.setGlobalPrefix("api"),
    });
    try {
      const r = await reach(booted.baseUrl);
      expect(r.status).toBe(200);
      expect(await probe.selfProbe).toBe("reachable");
    } finally {
      await booted.close();
    }
  });

  it("@Get('*splat') and a use() middleware added between host routes and ours", async () => {
    const booted = await bootApp(adapter, {
      module: hostModule({
        catchAll: catchAllFor(adapter),
        mount: { when: "init", strategy: "raw", selfProbe: true },
        extraImports: [InterposerModule],
        dashboardFirst: false,
      }),
    });
    try {
      const r = await reach(booted.baseUrl);
      const self = await probe.selfProbe;
      note(`Q3 ${adapter} catch-all + interposed use()`, {
        ...r,
        selfProbe: self,
        order: probe.order,
      });
      // The interposer ran first (else the case is not what it claims).
      expect(probe.order).toEqual(["interposer:use", "dashboard:init"]);
      if (adapter === "fastify") {
        expect(r.status).toBe(200);
        expect(self).toBe("reachable");
      } else {
        // platform-node groups only *contiguous* routes into one radix table;
        // a use() in between starts a new table after the catch-all's.
        expect(r.body).toBe("host-catch-all");
        expect(self).toBe("shadowed: status 200");
      }
    } finally {
      await booted.close();
    }
  });

  it("constructor-time registration is not shadowed by the catch-all", async () => {
    const booted = await bootApp(adapter, {
      module: hostModule({
        catchAll: catchAllFor(adapter),
        mount: { when: "constructor", strategy: "raw", selfProbe: true },
      }),
    });
    try {
      const r = await reach(booted.baseUrl);
      expect(r.status).toBe(200);
      expect(r.body).toMatch(/^\{"ok":true/);
      expect(await probe.selfProbe).toBe("reachable");
    } finally {
      await booted.close();
    }
  });
});

describe("Q3 @nestjs/serve-static SPA fallback ({*any}, registered in its own onModuleInit)", () => {
  const rootPath = fileURLToPath(dashboardDirectory);
  for (const adapter of ["express", "node"] as const) {
    for (const dashboardFirst of [true, false]) {
      it(`${adapter}, DashboardModule imported ${dashboardFirst ? "before" : "after"} ServeStaticModule`, async () => {
        const booted = await bootApp(adapter, {
          module: hostModule({
            mount: { when: "init", strategy: "raw", selfProbe: true },
            extraImports: [ServeStaticModule.forRoot({ rootPath })],
            dashboardFirst,
          }),
        });
        try {
          const r = await reach(booted.baseUrl);
          const self = await probe.selfProbe;
          note(
            `Q3 ${adapter} serve-static dashboard ${dashboardFirst ? "first" : "second"}`,
            { ...r, selfProbe: self },
          );
          // Sanity: the SPA fallback is live.
          const spa = await get(`${booted.baseUrl}/some/client/route`);
          expect(spa.status).toBe(200);
          expect(spa.headers["content-type"]).toMatch(/text\/html/);
          // Whatever the outcome, the self-probe agrees with what a client sees.
          expect(self === "reachable").toBe(r.body.startsWith('{"ok":true'));
          // Which onModuleInit runs first decides it: here, the import order.
          expect(self).toBe(
            dashboardFirst ? "reachable" : "shadowed: status 200",
          );
        } finally {
          await booted.close();
        }
      });
    }
  }
});

describe("Q3 detection on Express by reading the router stack (not a Nest API)", () => {
  it("finds the earlier route that matches GET /_nestrix/api/whoami", async () => {
    const booted = await bootApp("express", {
      module: hostModule({
        catchAll: true,
        mount: { when: "init", strategy: "raw" },
      }),
    });
    try {
      // Express 5 documents `app.router`; the layer objects and `match()` are not documented.
      const app = booted.app.getHttpAdapter().getInstance() as {
        router: {
          stack: {
            route?: { path: string; methods: Record<string, boolean> };
            match: (p: string) => boolean;
          }[];
        };
      };
      const matching = app.router.stack
        .filter(
          (l) =>
            l.route &&
            (l.route.methods.get || l.route.methods._all) &&
            l.match("/_nestrix/api/whoami"),
        )
        .map((l) => l.route?.path);
      note("Q3 express router-stack matches", matching);
      expect(matching[0]).toBe("/*splat");
      expect(matching).toContain("/_nestrix/api/whoami");
    } finally {
      await booted.close();
    }
  });
});
