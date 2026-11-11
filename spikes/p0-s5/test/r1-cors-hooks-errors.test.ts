import "reflect-metadata";
import { type AdapterName, bootApp } from "@nestrix/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { probe, resetProbe, type WriteStrategy } from "../src/dashboard.js";
import { hostModule } from "../src/host.js";
import { corsHeaders, get, note } from "./helpers.js";

/**
 * Review items 1, 3 and 4 (from the reviewer's probes e1.mjs and e2.mjs).
 */

const EVIL = "http://evil.example";
const adapters: AdapterName[] = ["express", "fastify", "node"];

beforeEach(() => resetProbe());

describe("R1 Fastify: @fastify/cors with hook 'preSerialization' runs after the handler", () => {
  for (const hook of ["onRequest", "preSerialization"] as const) {
    for (const strategy of ["adapter", "raw"] as WriteStrategy[]) {
      it(`hook ${hook}, ${strategy === "adapter" ? "strip both maps + reply.send()" : "hijack + raw write"}`, async () => {
        let onResponse = 0;
        const booted = await bootApp("fastify", {
          module: hostModule({
            mount: { when: "init", strategy, stripCors: true },
          }),
          configure: (app) => {
            (
              app.getHttpAdapter().getInstance() as {
                addHook: (
                  name: string,
                  fn: (req: unknown, reply: unknown, done: () => void) => void,
                ) => void;
              }
            ).addHook("onResponse", (_req, _reply, done) => {
              onResponse++;
              done();
            });
            app.enableCors({ origin: true, credentials: true, hook });
          },
        });
        try {
          const json = await get(`${booted.baseUrl}/_nestrix/api/whoami`, {
            origin: EVIL,
          });
          const blob = await get(`${booted.baseUrl}/_nestrix/assets/blob.bin`, {
            origin: EVIL,
          });
          const fails = await get(`${booted.baseUrl}/_nestrix/api/fails`, {
            origin: EVIL,
          });
          const hello = await get(`${booted.baseUrl}/hello`, { origin: EVIL });
          const obs = {
            json: corsHeaders(json.headers),
            blob: corsHeaders(blob.headers),
            failsStatus: fails.status,
            fails: corsHeaders(fails.headers),
            hello: corsHeaders(hello.headers),
            onResponseHookCalls: onResponse,
          };
          note(`R1 fastify cors hook=${hook} ${strategy}`, obs);
          expect(json.status).toBe(200);
          expect(fails.status).toBe(500);
          // With preSerialization even the host's /hello (a string payload, not
          // serialized) gets no CORS headers: that hook only covers objects.
          expect(obs.hello["access-control-allow-origin"]).toBe(
            hook === "onRequest" ? EVIL : undefined,
          );
          expect(obs.fails).toEqual({});
          // Fastify still runs onResponse hooks for hijacked replies: all 4.
          expect(obs.onResponseHookCalls).toBe(4);
          if (strategy === "raw") {
            // Nothing Fastify runs after the handler touches a hijacked reply.
            expect(obs.json).toEqual({});
            expect(obs.blob).toEqual({});
          } else if (hook === "preSerialization") {
            // Re-added after we stripped: reply.send() of an object serializes,
            // and @fastify/cors runs there.
            expect(obs.json).toEqual({
              "access-control-allow-origin": EVIL,
              "access-control-allow-credentials": "true",
            });
            // A Buffer payload is not serialized, so the hook does not run.
            expect(obs.blob).toEqual({});
          } else {
            expect(obs.json).toEqual({});
            expect(obs.blob).toEqual({});
          }
        } finally {
          await booted.close();
        }
      });
    }
  }
});

describe.each(adapters)(
  "R3 error path writes no host CORS headers (%s)",
  (adapter) => {
    it("work that throws inside a guarded raw handler: 500, no Access-Control-*", async () => {
      const booted = await bootApp(adapter, {
        module: hostModule({
          mount: { when: "init", strategy: "raw", stripCors: true },
        }),
        configure: (app) => app.enableCors({ origin: true, credentials: true }),
      });
      try {
        const r = await get(`${booted.baseUrl}/_nestrix/api/fails`, {
          origin: EVIL,
        });
        note(`R3 ${adapter} error path`, {
          status: r.status,
          cors: corsHeaders(r.headers),
          handlerErrors: probe.handlerErrors.length,
        });
        expect(r.status).toBe(500);
        expect(corsHeaders(r.headers)).toEqual({});
        expect(probe.handlerErrors).toHaveLength(1);
        expect(probe.handlerErrors[0]).toMatch(/dashboard work failed/);
      } finally {
        await booted.close();
      }
    });
  },
);

describe.each(adapters)(
  "R4 init$ registration vs host CORS (%s)",
  (adapter) => {
    it("actual response and preflight, without stripping", async () => {
      const booted = await bootApp(adapter, {
        module: hostModule({ mount: { when: "init$", strategy: "raw" } }),
        configure: (app) => app.enableCors({ origin: true, credentials: true }),
      });
      try {
        const actual = await get(`${booted.baseUrl}/_nestrix/api/whoami`, {
          origin: EVIL,
        });
        const preflight = await get(
          `${booted.baseUrl}/_nestrix/api/whoami`,
          {
            origin: EVIL,
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
          "OPTIONS",
        );
        const obs = {
          actual: corsHeaders(actual.headers),
          preflightStatus: preflight.status,
          preflight: corsHeaders(preflight.headers),
        };
        note(`R4 ${adapter} init$ + host CORS`, obs);
        expect(actual.status).toBe(200);
        // The host answers the preflight on every adapter: early registration
        // only adds a GET route, and the OPTIONS request matches none of ours.
        expect(obs.preflightStatus).toBe(204);
        expect(obs.preflight["access-control-allow-origin"]).toBe(EVIL);
        expect(obs.preflight["access-control-allow-credentials"]).toBe("true");
        if (adapter === "fastify") {
          expect(obs.actual["access-control-allow-origin"]).toBe(EVIL);
        } else {
          // Our GET route precedes cors() on Express and platform-node.
          expect(obs.actual).toEqual({});
        }
      } finally {
        await booted.close();
      }
    });
  },
);
