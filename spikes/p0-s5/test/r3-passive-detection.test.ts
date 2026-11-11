import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { ServeStaticModule } from "@nestjs/serve-static";
import { type AdapterName, bootApp } from "@nestrix/testing";
import { dashboardDirectory } from "@nestrix/ui";
import { beforeEach, describe, expect, it } from "vitest";
import { type MountOptions, probe, resetProbe } from "../src/dashboard.js";
import { type HostOptions, hostModule } from "../src/host.js";
import { get, note } from "./helpers.js";

/**
 * Review item 6: the reviewer's passive alternative to the startup self-request.
 * A request hook marks requests under the base path (AsyncLocalStorage); a
 * chained setOnRouteTriggered records a host route firing for one; a marked
 * request whose response closes without reaching our handler is "shadowed".
 * Both hooks are installed from init$, before routes are registered.
 */

@Injectable()
class Interposer implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}
  onModuleInit() {
    this.host.httpAdapter.use(
      (_req: unknown, _res: unknown, next: () => void) => next(),
    );
  }
}
@Module({ providers: [Interposer] })
class InterposerModule {}

beforeEach(() => resetProbe());

const mount: MountOptions = { when: "init", strategy: "raw", passive: true };

async function observe(adapter: AdapterName, opts: HostOptions) {
  const booted = await bootApp(adapter, {
    module: hostModule({ mount, ...opts }),
  });
  try {
    const r = await get(`${booted.baseUrl}/_nestrix/api/whoami`);
    // An unrelated host request is never marked.
    await get(`${booted.baseUrl}/hello`);
    await new Promise((res) => setTimeout(res, 20));
    return {
      reachedUs: r.body.toString().startsWith('{"ok":true'),
      passive: [...probe.passive],
      errors: [...probe.registrationErrors],
    };
  } finally {
    await booted.close();
  }
}

describe("R3 passive shadowing detection", () => {
  const rootPath = fileURLToPath(dashboardDirectory);
  const cases: [string, AdapterName, HostOptions, string | null][] = [
    ["express, controller catch-all", "express", { catchAll: true }, "route"],
    ["express, no catch-all", "express", {}, null],
    ["fastify, controller catch-all", "fastify", { catchAll: "fastify" }, null],
    ["node, controller catch-all", "node", { catchAll: true }, null],
    [
      "node, catch-all + interposed use()",
      "node",
      {
        catchAll: true,
        extraImports: [InterposerModule],
        dashboardFirst: false,
      },
      "route",
    ],
    [
      "express, serve-static fallback first",
      "express",
      {
        extraImports: [ServeStaticModule.forRoot({ rootPath })],
        dashboardFirst: false,
      },
      "no-route",
    ],
    [
      "node, serve-static fallback first",
      "node",
      {
        extraImports: [ServeStaticModule.forRoot({ rootPath })],
        dashboardFirst: false,
      },
      "no-route",
    ],
  ];
  for (const [label, adapter, opts, expected] of cases) {
    it(label, async () => {
      const obs = await observe(adapter, opts);
      note(`R3 passive ${label}`, obs);
      expect(obs.errors).toEqual([]);
      expect(obs.reachedUs).toBe(expected === null);
      if (expected === null) {
        expect(obs.passive).toEqual([]);
      } else if (expected === "route") {
        // A controller route: setOnRouteTriggered names it.
        expect(obs.passive).toHaveLength(1);
        expect(obs.passive[0]).toMatch(
          /^shadowed \/_nestrix\/api\/whoami by host route /,
        );
      } else {
        // An adapter-level route (serve-static): no route-triggered call, only
        // "closed without reaching our handler".
        expect(obs.passive).toEqual(["shadowed /_nestrix/api/whoami"]);
      }
    });
  }
});
