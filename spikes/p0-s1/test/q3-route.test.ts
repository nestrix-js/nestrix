import type { INestApplication } from "@nestjs/common";
import { VersioningType } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { spikeAppFor } from "../src/app-for.js";
import {
  ADAPTERS,
  type Booted,
  boot,
  NEST_LABEL,
  waitFor,
} from "../src/boot.js";
import {
  observations,
  resetHookConfig,
  resetObservations,
} from "../src/probe.js";

let booted: Booted | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  resetHookConfig();
  resetObservations();
});

interface RouteSeen {
  status: number;
  /** `METHOD path` for each route-hook call during the request, in order. */
  routes: string[];
  /** Store seen inside the route hook, for each call. */
  stores: (string | undefined)[];
  /** True if the route hook fired before the first guard. */
  beforeGuard: boolean | null;
}

async function hit(
  path: string,
  probe: string,
  headers: Record<string, string> = {},
): Promise<RouteSeen> {
  if (!booted) throw new Error("not booted");
  resetObservations();
  const res = await fetch(`${booted.baseUrl}${path}`, {
    headers: { ...headers, "x-probe": probe },
  });
  await res.arrayBuffer();
  await waitFor(
    () => observations.find((o) => o.point === "close" && o.probe === probe),
    2000,
    `close for ${probe}`,
  );
  const routeObs = observations.filter((o) => o.point === "route");
  const guard = observations.find((o) => o.point === "guard:global");
  return {
    status: res.status,
    routes: routeObs.map((o) => `${o.data?.method} ${o.data?.path}`),
    stores: routeObs.map((o) => o.storeProbe),
    beforeGuard: routeObs.length && guard ? routeObs[0].seq < guard.seq : null,
  };
}

async function bootWith(
  adapter: (typeof ADAPTERS)[number],
  configure: (app: INestApplication) => void,
  versioned = false,
): Promise<void> {
  booted = await boot(adapter, await spikeAppFor(adapter, { versioned }), {
    configure,
  });
}

describe.each(ADAPTERS)(
  `Q3 setOnRouteTriggered [%s, Nest ${NEST_LABEL}]`,
  (adapter) => {
    it("no prefix: declared paths, fires before guards, store readable", async () => {
      await bootWith(adapter, () => {});
      const results = {
        hello: await hit("/hello", "r1"),
        user: await hit("/users/42", "r2"),
        items: await hit("/orgs/7/items/9", "r3"),
        notFound: await hit("/no-such-route", "r4"),
        guarded: await hit("/private", "r5"),
      };
      console.log(`[${adapter}] no prefix`, JSON.stringify(results, null, 1));
      expect(results.hello).toEqual({
        status: 200,
        routes: ["GET /hello"],
        stores: ["r1"],
        beforeGuard: true,
      });
      expect(results.user).toEqual({
        status: 200,
        routes: ["GET /users/:id"],
        stores: ["r2"],
        beforeGuard: true,
      });
      expect(results.items).toEqual({
        status: 200,
        routes: ["GET /orgs/:orgId/items/:itemId"],
        stores: ["r3"],
        beforeGuard: true,
      });
      expect(results.notFound).toEqual({
        status: 404,
        routes: [],
        stores: [],
        beforeGuard: null,
      });
      // the controller guard rejects; the route hook has already fired
      expect(results.guarded.status).toBe(403);
      expect(results.guarded.routes).toEqual(["GET /private"]);
    });

    it("global prefix 'api'", async () => {
      await bootWith(adapter, (app) => app.setGlobalPrefix("api"));
      const user = await hit("/api/users/42", "p1");
      const items = await hit("/api/orgs/7/items/9", "p2");
      const unprefixed = await hit("/users/42", "p3");
      console.log(
        `[${adapter}] prefix`,
        JSON.stringify({ user, items, unprefixed }),
      );
      expect(user.routes).toEqual(["GET /api/users/:id"]);
      expect(items.routes).toEqual(["GET /api/orgs/:orgId/items/:itemId"]);
      expect(unprefixed).toMatchObject({ status: 404, routes: [] });
    });

    it("URI versioning, with and without a global prefix", async () => {
      await bootWith(
        adapter,
        (app) => app.enableVersioning({ type: VersioningType.URI }),
        true,
      );
      const v1 = await hit("/v1/ver/5", "u1");
      const v2 = await hit("/v2/ver/5", "u2");
      const unversioned = await hit("/users/42", "u3");
      console.log(
        `[${adapter}] uri versioning`,
        JSON.stringify({ v1, v2, unversioned }),
      );
      expect(v1).toMatchObject({
        status: 200,
        routes: ["GET /v1/ver/:id"],
        stores: ["u1"],
      });
      expect(v2).toMatchObject({
        status: 200,
        routes: ["GET /v2/ver/:id"],
        stores: ["u2"],
      });
      expect(unversioned.routes).toEqual(["GET /users/:id"]);
      await booted?.close();
      booted = undefined;
      await bootWith(
        adapter,
        (app) => {
          app.setGlobalPrefix("api");
          app.enableVersioning({ type: VersioningType.URI });
        },
        true,
      );
      const prefixed = await hit("/api/v2/ver/5", "u4");
      console.log(
        `[${adapter}] prefix + uri versioning`,
        JSON.stringify(prefixed),
      );
      expect(prefixed.routes).toEqual(["GET /api/v2/ver/:id"]);
    });

    it("header versioning with two versions of one route", async () => {
      if (NEST_LABEL === "12.0.0" && adapter === "fastify") {
        // Nest 12.0.0's Fastify adapter cannot register two versions of one route
        // under header versioning: the app does not start
        await expect(
          bootWith(
            adapter,
            (app) =>
              app.enableVersioning({
                type: VersioningType.HEADER,
                header: "x-api-version",
              }),
            true,
          ),
        ).rejects.toThrow("Method 'GET' already declared for route '/ver/:id'");
        return;
      }
      await bootWith(
        adapter,
        (app) =>
          app.enableVersioning({
            type: VersioningType.HEADER,
            header: "x-api-version",
          }),
        true,
      );
      const v1 = await hit("/ver/5", "h1", { "x-api-version": "1" });
      const v2 = await hit("/ver/5", "h2", { "x-api-version": "2" });
      const none = await hit("/ver/5", "h3");
      const handlers = observations.map((o) => o.point);
      console.log(
        `[${adapter}] header versioning`,
        JSON.stringify({ v1, v2, none, lastHandlers: handlers }),
      );
      expect(v1.status).toBe(200);
      expect(v2.status).toBe(200);
      expect(none.status).toBe(404);
      // per adapter, see the expectations recorded below
      if (adapter === "fastify") {
        // Fastify matches the version as a route constraint: only the winning
        // route's handler runs, so the hook fires once
        expect(v1.routes).toEqual(["GET /ver/:id"]);
        expect(v2.routes).toEqual(["GET /ver/:id"]);
        expect(none.routes).toEqual([]);
      } else {
        // Express and platform-node register both handlers on the same path and
        // a version filter inside each declines with next(): the hook fires for
        // every declining handler tried before the winner, and for each one on a
        // request that no version matches
        expect(v1.routes).toEqual(["GET /ver/:id"]);
        expect(v2.routes).toEqual(["GET /ver/:id", "GET /ver/:id"]);
        expect(none.routes).toEqual(["GET /ver/:id", "GET /ver/:id"]);
      }
    });
  },
);
