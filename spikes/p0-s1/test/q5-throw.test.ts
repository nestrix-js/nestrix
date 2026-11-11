import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spikeAppFor } from "../src/app-for.js";
import {
  ADAPTERS,
  BARE_HOOK_RUNNER,
  type Booted,
  boot,
  logs,
  NEST_LABEL,
  rawRequest,
} from "../src/boot.js";
import {
  type HookMode,
  hookConfig,
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
  logs.length = 0;
});

afterAll(() => {
  // the throwing modes are per-test only
  expect(hookConfig.mode).toBe("normal");
});

function get(path: string, probe: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-probe: ${probe}\r\nConnection: close\r\n\r\n`;
}

async function underMode(adapter: (typeof ADAPTERS)[number], mode: HookMode) {
  booted = await boot(adapter, await spikeAppFor(adapter));
  hookConfig.mode = mode;
  const reply = await rawRequest(booted.port, get("/probe/ctx?q=1", "t"), {
    timeoutMs: 1000,
  });
  hookConfig.mode = "normal";
  // let a handler that is still running finish, so its late errors land here
  await new Promise((r) => setTimeout(r, 100));
  const handlerRan = observations.some((o) => o.point === "handler");
  const guardRan = observations.some((o) => o.point === "guard:global");
  const errorLogs = logs
    .filter((l) => l.level === "error")
    .map((l) => l.message.split("\n")[0]);
  // the same app, with the hook behaving again
  const after = await rawRequest(booted.port, get("/hello", "after"), {
    timeoutMs: 1000,
  });
  const body = reply.text.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  return {
    status: reply.status,
    timedOut: reply.timedOut,
    body: body.slice(0, 200),
    handlerRan,
    guardRan,
    errorLogs,
    afterStatus: after.status,
  };
}

describe.each(ADAPTERS)(
  `Q5 a request hook that throws [%s, Nest ${NEST_LABEL}]`,
  (adapter) => {
    it("throws synchronously before done(): the user's request fails with 500", async () => {
      const r = await underMode(adapter, "throw-sync");
      console.log(`[${adapter}] throw-sync`, JSON.stringify(r, null, 1));
      expect(r.status).toBe(500);
      expect(r.handlerRan).toBe(false);
      expect(r.guardRan).toBe(false);
      // Nest's own exception handling answers; the error is logged as an error
      expect(r.body).toBe(
        '{"statusCode":500,"message":"Internal server error"}',
      );
      expect(r.errorLogs).toEqual([
        "Error: spike: request hook threw synchronously",
      ]);
      expect(r.afterStatus).toBe(200);
    });

    it("throws after done()", async () => {
      const r = await underMode(adapter, "throw-after-done");
      console.log(`[${adapter}] throw-after-done`, JSON.stringify(r, null, 1));
      expect(r.handlerRan).toBe(true);
      if (BARE_HOOK_RUNNER) {
        // 12.0.0: the throw reaches Express's / Fastify's own error handling after
        // the request was already passed on; the client gets a 500 although the
        // handler ran
        expect(r.status).toBe(500);
        expect(r.errorLogs[0]).toBe(
          "Error: spike: request hook threw after done()",
        );
        if (adapter === "express") {
          // and the handler's own response then fails
          expect(r.errorLogs).toContain(
            "Error: Cannot set headers after they are sent to the client",
          );
        }
      } else {
        // 12.4.2: the once-guard ignores it. Express and platform-node log it;
        // Fastify drops it silently
        expect(r.status).toBe(200);
        expect(r.errorLogs).toEqual(
          adapter === "fastify"
            ? []
            : ["Error: spike: request hook threw after done()"],
        );
      }
      expect(r.afterStatus).toBe(200);
    });

    it("the prescribed shape survives a fault inside its own body (fault injection)", async () => {
      const r = await underMode(adapter, "fault-in-body");
      console.log(`[${adapter}] fault-in-body`, JSON.stringify(r, null, 1));
      expect(r.status).toBe(200);
      expect(r.handlerRan).toBe(true);
      expect(r.errorLogs).toEqual([]);
      expect(observations.some((o) => o.point === "hook:fault")).toBe(true);
    });

    it("returns a resolved promise without calling done()", async () => {
      const r = await underMode(adapter, "promise-no-done");
      console.log(`[${adapter}] promise-no-done`, JSON.stringify(r, null, 1));
      if (adapter === "fastify" && !BARE_HOOK_RUNNER) {
        // Fastify continues on a settled promise
        expect(r.status).toBe(200);
        expect(r.handlerRan).toBe(true);
      } else {
        // Express and platform-node (and Fastify before 12.1.3) wait for done():
        // the request hangs
        expect(r.timedOut).toBe(true);
        expect(r.status).toBe(null);
        expect(r.handlerRan).toBe(false);
      }
      expect(r.afterStatus).toBe(200);
    });
  },
);
