import { afterEach, describe, expect, it } from "vitest";
import { spikeAppFor, summarise } from "../src/app-for.js";
import {
  ADAPTERS,
  type AdapterName,
  type Booted,
  boot,
  multipartBody,
  NEST_LABEL,
  NODE_JSON_PARSER_LOSES_STORE,
  slowBodyRequest,
  waitFor,
} from "../src/boot.js";
import {
  hookConfig,
  observations,
  resetHookConfig,
  resetObservations,
} from "../src/probe.js";

/**
 * The store expected downstream of a JSON body: platform-node before 12.3.2 runs
 * `next()` from its body parser in the socket's async context, so the store is
 * gone from the route hook on.
 */
function jsonStore(adapter: AdapterName, probe: string): string | undefined {
  return adapter === "node" && NODE_JSON_PARSER_LOSES_STORE ? undefined : probe;
}

let booted: Booted | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  resetHookConfig();
  resetObservations();
});

async function send(
  path: string,
  probe: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!booted) throw new Error("not booted");
  const res = await fetch(`${booted.baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-probe": probe },
  });
  await res.arrayBuffer();
  // the close listener fires after the response is sent; wait for it so every
  // observation for this request is in
  await waitFor(
    () => observations.find((o) => o.point === "close" && o.probe === probe),
    2000,
    `close for ${probe}`,
  );
  return res;
}

/** Observations made inside the request for `probe` (known probe, or store, or both). */
function seenFor(probe: string) {
  return observations.filter(
    (o) => o.probe === probe || o.storeProbe === probe,
  );
}

describe.each(ADAPTERS)(
  `Q1/Q2 ALS from the request hook [%s, Nest ${NEST_LABEL}]`,
  (adapter) => {
    it("Q1: GET /probe/ctx sees the store in guards, interceptor, pipe, handler and after awaits", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const res = await send("/probe/ctx?q=1", "q1");
      expect(res.status).toBe(200);
      const list = observations.filter(
        (o) => o.point !== "installed" && o.point !== "ctor",
      );
      console.log(
        `[${adapter}] GET /probe/ctx\n  ${summarise(list).join("\n  ")}`,
      );
      const points = [
        "route",
        "guard:global",
        "guard:method",
        "interceptor:before",
        "pipe:query",
        "handler",
        "handler:after-timer",
        "handler:after-fs",
        "handler:after-immediate",
        "interceptor:after",
      ];
      for (const point of points) {
        const o = list.find((x) => x.point === point);
        expect(o, point).toBeDefined();
        expect(o?.storeProbe, point).toBe("q1");
      }
      // the hook itself runs before the store exists (it creates it)
      expect(list.find((o) => o.point === "hook")?.storeProbe).toBeUndefined();
    });

    it("Q1 control: with done() called outside als.run(), no probe sees a store (so the probes can fail)", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      hookConfig.mode = "done-outside-run";
      const res = await send("/probe/ctx?q=1", "ctl");
      expect(res.status).toBe(200);
      const tagged = observations.filter(
        (o) => o.probe === "ctl" && o.point !== "hook",
      );
      expect(tagged.length).toBeGreaterThan(5);
      expect(tagged.every((o) => o.storeProbe === undefined)).toBe(true);
    });

    it("Q1: 50 concurrent requests each see only their own store", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const probes = Array.from({ length: 50 }, (_, i) => `c${i}`);
      await Promise.all(probes.map((p) => send("/probe/ctx?q=1", p)));
      // the route hook and the pipe get no request: only the store says which
      // request they ran for. Each must have run once per request, in its store.
      for (const point of ["route", "pipe:query"]) {
        const stores = observations
          .filter((o) => o.point === point)
          .map((o) => o.storeProbe);
        expect(stores, point).toHaveLength(50);
        expect(new Set(stores), point).toEqual(new Set(probes));
      }
      let mismatches = 0;
      for (const o of observations) {
        if (
          o.probe &&
          o.point !== "hook" &&
          o.point !== "close" &&
          o.storeProbe !== o.probe
        )
          mismatches++;
      }
      const checked = observations.filter(
        (o) => o.probe && o.point !== "hook" && o.point !== "close",
      ).length;
      console.log(
        `[${adapter}] concurrency: ${checked} probe-tagged observations, ${mismatches} mismatches`,
      );
      expect(checked).toBe(50 * 8);
      expect(mismatches).toBe(0);
    });

    it("Q1: request-scoped provider and controller are constructed inside the store", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const res = await send("/probe-scoped", "rs");
      expect(res.status).toBe(200);
      const list = seenFor("rs").concat(
        observations.filter((o) => o.point === "scoped-controller:ctor"),
      );
      console.log(
        `[${adapter}] GET /probe-scoped\n  ${summarise(list).join("\n  ")}`,
      );
      for (const point of [
        "request-scoped:ctor",
        "scoped-controller:ctor",
        "handler",
        "request-scoped:method",
        "request-scoped:after-await",
      ]) {
        expect(
          observations.find((o) => o.point === point)?.storeProbe,
          point,
        ).toBe("rs");
      }
    });

    it("Q2: POST /probe/echo (JSON body parsed between hook and handler)", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const res = await send("/probe/echo", "echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(res.status).toBe(201);
      const list = seenFor("echo");
      console.log(
        `[${adapter}] POST /probe/echo\n  ${summarise(list).join("\n  ")}`,
      );
      for (const point of [
        "guard:global",
        "interceptor:before",
        "handler",
        "handler:after-timer",
        "interceptor:after",
      ]) {
        expect(
          observations.find((o) => o.point === point)?.storeProbe,
          point,
        ).toBe(jsonStore(adapter, "echo"));
      }
      expect(
        observations.find((o) => o.point === "pipe:body")?.storeProbe,
      ).toBe(jsonStore(adapter, "echo"));
    });

    it("Q2: POST /echo on the fixture (global probes only)", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const res = await send("/echo", "fx-echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(res.status).toBe(201);
      const list = observations.filter(
        (o) => o.point !== "installed" && o.point !== "ctor",
      );
      console.log(
        `[${adapter}] POST /echo (fixture)\n  ${summarise(list).join("\n  ")}`,
      );
      for (const point of [
        "route",
        "guard:global",
        "interceptor:before",
        "pipe:body",
        "interceptor:after",
      ]) {
        expect(list.find((o) => o.point === point)?.storeProbe, point).toBe(
          jsonStore(adapter, "fx-echo"),
        );
      }
    });

    it("Q2: POST /probe/upload (multipart read in the handler)", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const { body, contentType } = multipartBody();
      const res = await send("/probe/upload", "up", {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Uint8Array(body),
      });
      expect(res.status).toBe(201);
      const list = seenFor("up");
      console.log(
        `[${adapter}] POST /probe/upload\n  ${summarise(list).join("\n  ")}`,
      );
      for (const point of [
        "guard:global",
        "interceptor:before",
        "handler",
        "handler:after-parse",
        "interceptor:after",
      ]) {
        expect(
          observations.find((o) => o.point === point)?.storeProbe,
          point,
        ).toBe("up");
      }
    });

    it("Q2: POST /upload on the fixture (global probes only)", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const { body, contentType } = multipartBody();
      const res = await send("/upload", "fx-up", {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Uint8Array(body),
      });
      expect(res.status).toBe(201);
      const list = observations.filter(
        (o) => o.point !== "installed" && o.point !== "ctor",
      );
      console.log(
        `[${adapter}] POST /upload (fixture)\n  ${summarise(list).join("\n  ")}`,
      );
      for (const point of [
        "route",
        "guard:global",
        "interceptor:before",
        "interceptor:after",
      ]) {
        expect(list.find((o) => o.point === point)?.storeProbe, point).toBe(
          "fx-up",
        );
      }
    });

    it.runIf(adapter !== "fastify")(
      "Q2: POST /probe/upload-multer (and the fixture /upload-multer on Express): multer interceptor parses between hook and handler",
      async () => {
        booted = await boot(adapter, await spikeAppFor(adapter));
        const paths: [string, string][] = [["/probe/upload-multer", "mul"]];
        if (adapter === "express") paths.push(["/upload-multer", "fx-mul"]);
        for (const [path, probe] of paths) {
          resetObservations();
          const { body, contentType } = multipartBody();
          const res = await send(path, probe, {
            method: "POST",
            headers: { "content-type": contentType },
            body: new Uint8Array(body),
          });
          expect(res.status).toBe(201);
          const list = observations.filter(
            (o) => o.point !== "installed" && o.point !== "ctor",
          );
          console.log(
            `[${adapter}] POST ${path}\n  ${summarise(list).join("\n  ")}`,
          );
          const points = [
            "route",
            "guard:global",
            "interceptor:before",
            "interceptor:after",
          ];
          if (probe === "mul") points.push("handler");
          for (const point of points) {
            expect(
              list.find((o) => o.point === point)?.storeProbe,
              `${path} ${point}`,
            ).toBe(probe);
          }
        }
      },
    );

    it("Q2: bodies that arrive in later TCP packets (headers first, body in 3 pieces 40 ms apart)", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const json = Buffer.from(
        JSON.stringify({ hello: "world", pad: "x".repeat(200) }),
      );
      const { body: multipart, contentType } = multipartBody();
      const cases: {
        path: string;
        probe: string;
        type: string;
        body: Buffer;
        points: string[];
        json?: boolean;
      }[] = [
        {
          path: "/probe/echo",
          probe: "slow-echo",
          type: "application/json",
          body: json,
          json: true,
          points: [
            "route",
            "guard:global",
            "interceptor:before",
            "pipe:body",
            "handler",
            "handler:after-timer",
            "interceptor:after",
          ],
        },
        {
          path: "/echo",
          probe: "slow-fx-echo",
          type: "application/json",
          body: json,
          json: true,
          points: [
            "route",
            "guard:global",
            "interceptor:before",
            "pipe:body",
            "interceptor:after",
          ],
        },
        {
          path: "/probe/upload",
          probe: "slow-up",
          type: contentType,
          body: multipart,
          points: [
            "route",
            "guard:global",
            "interceptor:before",
            "handler",
            "handler:after-parse",
            "interceptor:after",
          ],
        },
      ];
      if (adapter !== "fastify") {
        cases.push({
          path: "/probe/upload-multer",
          probe: "slow-mul",
          type: contentType,
          body: multipart,
          points: [
            "route",
            "guard:global",
            "interceptor:before",
            "pipe:custom",
            "handler",
            "interceptor:after",
          ],
        });
      }
      for (const c of cases) {
        resetObservations();
        const head = [
          `POST ${c.path} HTTP/1.1`,
          "Host: 127.0.0.1",
          `Content-Type: ${c.type}`,
          `Content-Length: ${c.body.length}`,
          `x-probe: ${c.probe}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n");
        const reply = await slowBodyRequest(booted.port, head, c.body);
        expect(reply.status, c.path).toBe(201);
        await waitFor(
          () => observations.find((o) => o.point === "close"),
          2000,
          "close",
        );
        const list = observations.filter(
          (o) => o.point !== "installed" && o.point !== "ctor",
        );
        console.log(
          `[${adapter}] slow body POST ${c.path}\n  ${summarise(list).join("\n  ")}`,
        );
        for (const point of c.points) {
          expect(
            list.find((o) => o.point === point)?.storeProbe,
            `${c.path} ${point}`,
          ).toBe(c.json ? jsonStore(adapter, c.probe) : c.probe);
        }
      }
    });
  },
);
