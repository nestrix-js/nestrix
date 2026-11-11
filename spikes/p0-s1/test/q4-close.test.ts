import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { spikeAppFor } from "../src/app-for.js";
import {
  ADAPTERS,
  type Booted,
  boot,
  NEST_LABEL,
  rawRequest,
  waitFor,
} from "../src/boot.js";
import {
  type Observation,
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

function get(path: string, probe: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-probe: ${probe}\r\nConnection: close\r\n\r\n`;
}

async function closeFor(probe: string, timeoutMs = 3000): Promise<Observation> {
  return waitFor(
    () => observations.find((o) => o.point === "close" && o.probe === probe),
    timeoutMs,
    `close for ${probe}`,
  );
}

/** Sends GET `path`, destroys the socket after `delayMs` or once `afterText` arrives. */
function abortingClient(
  port: number,
  path: string,
  probe: string,
  opts: { delayMs?: number; afterText?: string },
): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    socket.setEncoding("latin1");
    const stop = () => {
      socket.destroy();
      resolve(text);
    };
    socket.on("data", (c: string) => {
      text += c;
      if (opts.afterText && text.includes(opts.afterText)) stop();
    });
    socket.on("error", () => resolve(text));
    socket.write(get(path, probe));
    if (opts.delayMs !== undefined) setTimeout(stop, opts.delayMs);
  });
}

describe.each(ADAPTERS)(
  `Q4 close listener on the raw response [%s, Nest ${NEST_LABEL}]`,
  (adapter) => {
    it("fires once for every completed response, with writableFinished true", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const cases = [
        ["/hello", "ok", 200],
        ["/no-such-route", "nf", 404],
        ["/private", "guard", 403],
        ["/boom", "boom", 500],
        ["/teapot", "teapot", 418],
        ["/stream", "stream", 200],
      ] as const;
      const table: Record<string, unknown> = {};
      for (const [path, probe, status] of cases) {
        const reply = await rawRequest(booted.port, get(path, probe), {
          timeoutMs: 3000,
        });
        expect(reply.status, path).toBe(status);
        const close = await closeFor(probe);
        table[path] = {
          ...close.data,
          storeInListener: close.storeProbe ?? null,
        };
        expect(close.data?.writableFinished, path).toBe(true);
        expect(close.data?.writableEnded, path).toBe(true);
        expect(close.data?.headersSent, path).toBe(true);
        expect(close.data?.statusCode, path).toBe(status);
        // for a completed response the listener runs inside the request's store
        expect(close.storeProbe, path).toBe(probe);
        if (path === "/stream") expect(reply.text).toContain("chunk 4");
      }
      console.log(
        `[${adapter}] completed responses`,
        JSON.stringify(table, null, 1),
      );
      // exactly one close per request
      for (const [, probe] of cases) {
        expect(
          observations.filter((o) => o.point === "close" && o.probe === probe),
        ).toHaveLength(1);
      }
    });

    it("fires for a client that aborts mid-stream, with writableFinished false", async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const received = await abortingClient(
        booted.port,
        "/stream",
        "abort-mid",
        { afterText: "chunk 1" },
      );
      expect(received).toContain("chunk 1");
      const mid = await closeFor("abort-mid");
      const early = await (async () => {
        if (!booted) throw new Error("not booted");
        await abortingClient(booted.port, "/stream", "abort-early", {
          delayMs: 50,
        });
        return closeFor("abort-early");
      })();
      // a non-streaming handler still running when the client goes away
      if (!booted) throw new Error("not booted");
      await abortingClient(booted.port, "/probe/slow", "abort-handler", {
        delayMs: 50,
      });
      const handler = await closeFor("abort-handler").catch((e) => {
        console.log(
          JSON.stringify(
            observations.filter(
              (o) =>
                o.probe === "abort-handler" || o.storeProbe === "abort-handler",
            ),
          ),
        );
        throw e;
      });
      const handlerSeqAtClose = observations
        .filter((o) => o.storeProbe === "abort-handler" && o.seq < handler.seq)
        .map((o) => o.point);
      console.log(
        `[${adapter}] aborts`,
        JSON.stringify(
          {
            mid: { ...mid.data, storeInListener: mid.storeProbe ?? null },
            early: { ...early.data, storeInListener: early.storeProbe ?? null },
            handler: {
              ...handler.data,
              storeInListener: handler.storeProbe ?? null,
              before: handlerSeqAtClose,
            },
          },
          null,
          1,
        ),
      );
      // headersSent: whether the response had started
      expect(mid.data?.headersSent).toBe(true);
      expect(early.data?.headersSent).toBe(false);
      expect(handler.data?.headersSent).toBe(false);
      // the handler was still running when the client went away
      expect(handlerSeqAtClose).toContain("handler");
      expect(handlerSeqAtClose).not.toContain("handler:after-sleep");
      for (const [name, c] of Object.entries({ mid, early, handler })) {
        // nothing finished: neither the app nor the delivery
        expect(c.data?.writableEnded, name).toBe(false);
        expect(c.data?.writableFinished, name).toBe(false);
        // statusCode is the default 200 even where nothing was sent
        expect(c.data?.statusCode, name).toBe(200);
        // on an abort the listener runs outside the request's store
        expect(c.storeProbe, name).toBeUndefined();
      }
      // let the streams finish (or fail) before close, so nothing leaks into the next test
      await new Promise((r) => setTimeout(r, 1200));
      for (const probe of ["abort-mid", "abort-early", "abort-handler"]) {
        expect(
          observations.filter((o) => o.point === "close" && o.probe === probe),
          probe,
        ).toHaveLength(1);
      }
    });

    it("app finished, delivery cut: 201 with a 16 MiB body, client leaves after the first bytes", {
      timeout: 15_000,
    }, async () => {
      booted = await boot(adapter, await spikeAppFor(adapter));
      const received = await abortingClient(booted.port, "/probe/big", "big", {
        afterText: "HTTP/1.1",
      });
      expect(received).toMatch(/^HTTP\/1\.1 201/);
      const close = await closeFor("big", 5000);
      console.log(
        `[${adapter}] big body cut`,
        JSON.stringify(
          { ...close.data, storeInListener: close.storeProbe ?? null },
          null,
          1,
        ),
      );
      // headersSent: statusCode is what was sent
      expect(close.data?.headersSent).toBe(true);
      expect(close.data?.statusCode).toBe(201);
      // the app ended the response, the bytes did not all leave
      expect(close.data?.writableEnded).toBe(true);
      expect(close.data?.writableFinished).toBe(false);
      expect(
        observations.filter((o) => o.point === "close" && o.probe === "big"),
      ).toHaveLength(1);
    });
  },
);
