import "reflect-metadata";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type AdapterName, bootApp } from "@nestrix/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetProbe } from "../src/dashboard.js";
import { hostModule, hostSeen, resetHostSeen } from "../src/host.js";
import { get, note, portOf, rawHttp } from "./helpers.js";

/** Review item 2 (loopback rule limits) and the reviewer's probe e3.mjs (async rejection). */

const adapters: AdapterName[] = ["express", "fastify", "node"];

beforeEach(() => {
  resetProbe();
  resetHostSeen();
});

const whoami = (host: string | null, extra = "") =>
  `GET /_nestrix/api/whoami HTTP/${host === null ? "1.0" : "1.1"}\r\n` +
  (host === null ? "" : `Host: ${host}\r\n`) +
  extra +
  "Connection: close\r\n\r\n";

function request(r: { body: string }) {
  return JSON.parse(r.body).request as Record<string, unknown>;
}

/**
 * A same-host reverse proxy with nginx's defaults: `proxy_pass
 * http://127.0.0.1:<port>` sets `Host: $proxy_host` (the upstream address)
 * and adds no X-Forwarded-* unless configured to.
 */
function nginxDefaultsProxy(upstreamPort: number): Promise<Server> {
  const server = createServer((req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
    const up = httpRequest(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

let proxy: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
  proxy = undefined;
});

describe.each(adapters)(
  "R2 candidate D-30 rule on raw socket and headers (%s)",
  (adapter) => {
    it("what each request looks like to the rule", async () => {
      const booted = await bootApp(adapter, {
        module: hostModule({ mount: { when: "init", strategy: "raw" } }),
      });
      try {
        const port = portOf(booted.baseUrl);
        const send = (raw: string) => rawHttp("127.0.0.1", port, raw);
        const cases: Record<string, Record<string, unknown>> = {
          direct: request(await send(whoami(`127.0.0.1:${port}`))),
          localhost: request(await send(whoami(`localhost:${port}`))),
          foreignHost: request(await send(whoami("public.example"))),
          noHostHttp10: request(await send(whoami(null))),
          xForwardedFor: request(
            await send(
              whoami(`127.0.0.1:${port}`, "X-Forwarded-For: 203.0.113.9\r\n"),
            ),
          ),
          forwarded: request(
            await send(
              whoami(`127.0.0.1:${port}`, "Forwarded: for=203.0.113.9\r\n"),
            ),
          ),
          xForwardedHost: request(
            await send(
              whoami(
                `127.0.0.1:${port}`,
                "X-Forwarded-Host: public.example\r\n",
              ),
            ),
          ),
          xRealIp: request(
            await send(
              whoami(`127.0.0.1:${port}`, "X-Real-IP: 203.0.113.9\r\n"),
            ),
          ),
          via: request(
            await send(
              whoami(`127.0.0.1:${port}`, "Via: 1.1 proxy.example\r\n"),
            ),
          ),
        };
        // Public traffic through a same-host proxy with nginx defaults.
        proxy = await nginxDefaultsProxy(port);
        const proxyPort = (proxy.address() as AddressInfo).port;
        cases.viaNginxDefaultsProxy = request(
          await rawHttp(
            "127.0.0.1",
            proxyPort,
            "GET /_nestrix/api/whoami HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n",
          ),
        );
        const verdicts = Object.fromEntries(
          Object.entries(cases).map(([k, v]) => [k, v.localByRule]),
        );
        note(`R2 ${adapter} rule verdicts`, verdicts);
        note(`R2 ${adapter} proxied request as seen`, {
          socket: cases.viaNginxDefaultsProxy.socketRemoteAddress,
          host: cases.viaNginxDefaultsProxy.hostHeader,
          xff: cases.viaNginxDefaultsProxy.xForwardedFor,
        });
        // The new headers are readable from the raw message.
        expect(cases.xForwardedHost.xForwardedHost).toBe("public.example");
        expect(cases.xRealIp.xRealIp).toBe("203.0.113.9");
        expect(cases.via.via).toBe("1.1 proxy.example");
        expect(verdicts).toEqual({
          direct: true,
          localhost: true,
          foreignHost: false,
          noHostHttp10: false,
          xForwardedFor: false,
          forwarded: false,
          xForwardedHost: false,
          xRealIp: false,
          via: false,
          // The bypass: loopback socket, loopback Host, no forwarding header.
          // Indistinguishable from a local browser at the request level.
          viaNginxDefaultsProxy: true,
        });
      } finally {
        await booted.close();
      }
    });
  },
);

describe.each(adapters)(
  "R2 async rejection from an unguarded handler (%s)",
  (adapter) => {
    it("who handles it", async () => {
      let unhandled = 0;
      const onUnhandled = () => {
        unhandled++;
      };
      process.on("unhandledRejection", onUnhandled);
      const booted = await bootApp(adapter, {
        module: hostModule({
          enhancers: true,
          mount: { when: "init", strategy: "raw" },
        }),
      });
      try {
        let status: number | string;
        try {
          status = (await get(`${booted.baseUrl}/_nestrix/api/throws-async`))
            .status;
        } catch (e) {
          status = (e as Error).message;
        }
        await new Promise((r) => setTimeout(r, 50));
        const obs = {
          status,
          hostFilterCalls: hostSeen.filter,
          filterErrors: hostSeen.filterErrors,
          unhandled,
        };
        note(`R2 ${adapter} async rejection`, obs);
        // All three adapters forward a rejected handler promise to the error path.
        expect(obs.status).toBe(500);
        expect(obs.hostFilterCalls).toBe(1);
        expect(obs.filterErrors).toEqual(["dashboard handler rejected"]);
        expect(obs.unhandled).toBe(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        await booted.close();
      }
    });
  },
);
