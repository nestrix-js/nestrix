import { createRequire } from "node:module";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, it } from "vitest";
import { spikeAppFor } from "../src/app-for.js";
import {
  ADAPTERS,
  type Booted,
  boot,
  NEST_LABEL,
  rawRequest,
} from "../src/boot.js";
import {
  observations,
  record,
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

interface Case {
  name: string;
  /** Request line target, or a full raw request when `raw` is set. */
  target?: string;
  raw?: string;
}

const long = "a".repeat(150);

const cases: Case[] = [
  { name: "valid", target: "/users/42" },
  { name: "bad percent escape", target: "/users/%zz" },
  { name: "lone percent", target: "/users/%" },
  { name: "invalid UTF-8 escape", target: "/users/%FF" },
  { name: "param over 100 chars", target: `/users/${long}` },
  { name: "fragment in target", target: "/hello#frag" },
  { name: "absolute-form target", target: "http://127.0.0.1/hello" },
  { name: "target without leading slash", target: "hello" },
  {
    name: "invalid header name (Node parser)",
    raw: "GET /hello HTTP/1.1\r\nHost: x\r\nx-probe: PROBE\r\nBad Header: 1\r\nConnection: close\r\n\r\n",
  },
  {
    name: "headers over 16 KiB (Node parser)",
    raw: `GET /hello HTTP/1.1\r\nHost: x\r\nx-probe: PROBE\r\nx-big: ${"b".repeat(20000)}\r\nConnection: close\r\n\r\n`,
  },
];

describe.each(ADAPTERS)(
  `Q6 requests that never reach the hook [%s, Nest ${NEST_LABEL}]`,
  (adapter) => {
    it("records, per malformed request, the status and whether the hook ran", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const table: Record<
        string,
        { status: number | null; hook: boolean; close: boolean }
      > = {};
      let i = 0;
      for (const c of cases) {
        const probe = `m${i++}`;
        const request =
          c.raw?.replace("PROBE", probe) ??
          `GET ${c.target} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-probe: ${probe}\r\nConnection: close\r\n\r\n`;
        const reply = await rawRequest(booted.port, request, {
          timeoutMs: 1500,
        });
        await new Promise((r) => setTimeout(r, 20));
        table[c.name] = {
          status: reply.status,
          hook: observations.some(
            (o) => o.point === "hook" && o.probe === probe,
          ),
          close: observations.some(
            (o) => o.point === "close" && o.probe === probe,
          ),
        };
      }
      console.log(`[${adapter}] malformed`, JSON.stringify(table, null, 1));
      // every request that reached the hook also got its close event
      for (const [name, row] of Object.entries(table)) {
        if (row.hook) expect(row.close, name).toBe(true);
      }
      expect(table).toEqual(EXPECTED[adapter]);
    });
  },
);

const row = (status: number | null, hook: boolean) => ({
  status,
  hook,
  close: hook,
});

/** Observed on Nest 12.4.2, Node 26.13.0 (see docs/spikes/P0-S1.md). */
const EXPECTED: Record<string, Record<string, ReturnType<typeof row>>> = {
  express: {
    valid: row(200, true),
    "bad percent escape": row(400, true),
    "lone percent": row(400, true),
    "invalid UTF-8 escape": row(400, true),
    "param over 100 chars": row(200, true),
    "fragment in target": row(200, true),
    "absolute-form target": row(200, true),
    "target without leading slash": row(400, false),
    "invalid header name (Node parser)": row(400, false),
    "headers over 16 KiB (Node parser)": row(431, false),
  },
  fastify: {
    valid: row(200, true),
    "bad percent escape": row(400, false),
    "lone percent": row(400, false),
    "invalid UTF-8 escape": row(400, false),
    "param over 100 chars": row(414, false),
    "fragment in target": row(200, true),
    "absolute-form target": row(200, true),
    "target without leading slash": row(400, false),
    "invalid header name (Node parser)": row(400, false),
    "headers over 16 KiB (Node parser)": row(431, false),
  },
  node: {
    valid: row(200, true),
    "bad percent escape": row(400, true),
    "lone percent": row(400, true),
    "invalid UTF-8 escape": row(400, true),
    "param over 100 chars": row(414, true),
    "fragment in target": row(400, true),
    "absolute-form target": row(200, true),
    "target without leading slash": row(400, false),
    "invalid header name (Node parser)": row(400, false),
    "headers over 16 KiB (Node parser)": row(431, false),
  },
};

const requireHere = createRequire(import.meta.url);

/** Loads the server library the way the adapter package resolves it. */
function serverLibrary(adapterPackage: string, name: string): unknown {
  return createRequire(requireHere.resolve(adapterPackage))(name);
}

interface MiniReq {
  url: string;
  headers: Record<string, string | undefined>;
}

describe.each(ADAPTERS.filter((a) => a !== "node"))(
  `Q6 host-supplied server instance with its own early layer [%s, Nest ${NEST_LABEL}]`,
  (adapter) => {
    it("runs before the hook, sees no store, and can answer without the hook ever running", async () => {
      // The host's own early layer: records the store it sees and answers /early
      // with 429 before Nest's adapter middleware gets the request.
      const early = (req: MiniReq, answer: () => void, next: () => void) => {
        record("host-early", req.headers["x-probe"], { url: req.url });
        if (req.url === "/early") answer();
        else next();
      };
      let adapterInstance: unknown;
      if (adapter === "express") {
        const express = serverLibrary(
          "@nestjs/platform-express",
          "express",
        ) as () => {
          use: (
            mw: (
              req: MiniReq,
              res: { statusCode: number; end: () => void },
              next: () => void,
            ) => void,
          ) => void;
        };
        const server = express();
        server.use((req, res, next) =>
          early(
            req,
            () => {
              res.statusCode = 429;
              res.end();
            },
            next,
          ),
        );
        adapterInstance = new ExpressAdapter(server as never);
      } else {
        const fastify = serverLibrary(
          "@nestjs/platform-fastify",
          "fastify",
        ) as () => {
          addHook: (
            name: "onRequest",
            hook: (
              req: MiniReq,
              reply: { code: (n: number) => { send: () => void } },
              done: () => void,
            ) => void,
          ) => void;
        };
        const instance = fastify();
        instance.addHook("onRequest", (req, reply, done) =>
          early(req, () => reply.code(429).send(), done),
        );
        adapterInstance = new FastifyAdapter(instance as never);
      }
      booted = await boot(adapter, await spikeAppFor(adapter), {
        adapterInstance,
      });
      const a = await rawRequest(
        booted.port,
        "GET /early HTTP/1.1\r\nHost: x\r\nx-probe: e1\r\nConnection: close\r\n\r\n",
      );
      const b = await rawRequest(
        booted.port,
        "GET /hello HTTP/1.1\r\nHost: x\r\nx-probe: e2\r\nConnection: close\r\n\r\n",
      );
      await new Promise((r) => setTimeout(r, 20));
      const seen = observations
        .filter((o) => o.probe === "e1" || o.probe === "e2")
        .map((o) => `${o.point}[${o.probe}] -> ${o.storeProbe ?? "NO STORE"}`);
      console.log(
        `[${adapter}] host-supplied instance`,
        JSON.stringify({ early: a.status, hello: b.status, seen }, null, 1),
      );
      expect(a.status).toBe(429);
      expect(b.status).toBe(200);
      expect(seen).toEqual([
        "host-early[e1] -> NO STORE",
        "host-early[e2] -> NO STORE",
        "hook[e2] -> NO STORE",
        "guard:global[e2] -> e2",
        "interceptor:before[e2] -> e2",
        "interceptor:after[e2] -> e2",
        "close[e2] -> e2",
      ]);
    });
  },
);
