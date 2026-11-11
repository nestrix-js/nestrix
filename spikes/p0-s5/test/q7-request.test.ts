import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { NodeAdapter } from "@nestjs/platform-node";
import type { AdapterName } from "@nestrix/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { resetProbe } from "../src/dashboard.js";
import { hostModule } from "../src/host.js";
import { note, rawHttp } from "./helpers.js";

const adapters: AdapterName[] = ["express", "fastify", "node"];

beforeEach(() => resetProbe());

/** NestFactory.create with adapter options the shared harness does not expose. */
async function boot(
  adapter: AdapterName,
  listenHost: string,
  trustProxy: boolean,
): Promise<{ app: INestApplication; port: number }> {
  let instance: ExpressAdapter | FastifyAdapter | NodeAdapter;
  if (adapter === "express") {
    const express = new ExpressAdapter();
    if (trustProxy) express.set("trust proxy", true);
    instance = express;
  } else if (adapter === "fastify") {
    instance = new FastifyAdapter({ trustProxy });
  } else {
    instance = new NodeAdapter({ trustProxy });
  }
  const app = await NestFactory.create(
    hostModule({ mount: { when: "init", strategy: "raw" } }),
    instance,
    { logger: false },
  );
  await app.listen(0, listenHost);
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, port };
}

function parse(res: { statusLine: string; body: string }) {
  // Content-Length is set, so the body is the JSON as sent.
  return {
    statusLine: res.statusLine,
    request: res.body ? JSON.parse(res.body).request : null,
  };
}

const spoofed = (port: number, extra = "") =>
  "GET /_nestrix/api/whoami HTTP/1.1\r\n" +
  "Host: evil.example\r\n" +
  "X-Forwarded-For: 203.0.113.9\r\n" +
  "X-Forwarded-Host: forwarded.example\r\n" +
  "Forwarded: for=203.0.113.9;host=forwarded.example\r\n" +
  "Sec-Fetch-Site: cross-site\r\n" +
  extra +
  "Connection: close\r\n\r\n" +
  // keep port referenced for readability of the request line
  (port ? "" : "");

describe.each(adapters)("Q7 what the handler sees (%s)", (adapter) => {
  for (const trustProxy of [false, true]) {
    it(`spoofed Host and forwarding headers over 127.0.0.1 (trustProxy=${trustProxy})`, async () => {
      const { app, port } = await boot(adapter, "127.0.0.1", trustProxy);
      try {
        const r = parse(await rawHttp("127.0.0.1", port, spoofed(port)));
        note(`Q7 ${adapter} spoofed trustProxy=${trustProxy}`, r);
        expect(r.statusLine).toBe("HTTP/1.1 200 OK");
        const q = r.request;
        // The raw socket and raw headers never lie about what arrived.
        expect(q.socketRemoteAddress).toBe("127.0.0.1");
        expect(q.hostHeader).toBe("evil.example");
        expect(q.xForwardedFor).toBe("203.0.113.9");
        expect(q.forwarded).toBe("for=203.0.113.9;host=forwarded.example");
        expect(q.secFetchSite).toBe("cross-site");
        expect(q.reqIsIncomingMessage).toBe(adapter !== "fastify");
        expect(q.hasRaw).toBe(adapter === "fastify");
        if (trustProxy) {
          // The framework's own view follows the forwarding headers.
          expect(q.reqIp).toBe("203.0.113.9");
          expect(q.adapterHostname).toBe("forwarded.example");
        } else {
          expect(q.reqIp).toBe("127.0.0.1");
          expect(q.adapterHostname).toBe("evil.example");
        }
      } finally {
        await app.close();
      }
    });
  }

  it("HTTP/1.0 without Host; HTTP/1.1 without Host", async () => {
    const { app, port } = await boot(adapter, "127.0.0.1", false);
    try {
      const v10 = parse(
        await rawHttp(
          "127.0.0.1",
          port,
          "GET /_nestrix/api/whoami HTTP/1.0\r\n\r\n",
        ),
      );
      const v11 = await rawHttp(
        "127.0.0.1",
        port,
        "GET /_nestrix/api/whoami HTTP/1.1\r\nConnection: close\r\n\r\n",
      );
      note(`Q7 ${adapter} no Host`, {
        v10,
        v11: v11.statusLine,
      });
      expect(v10.request.hostHeader).toBeNull();
      expect(v10.request.httpVersion).toBe("1.0");
      // Node's server rejects an HTTP/1.1 request with no Host before any handler.
      expect(v11.statusLine).toBe("HTTP/1.1 400 Bad Request");
    } finally {
      await app.close();
    }
  });

  it("IPv6 loopback, and IPv4 through a dual-stack '::' listener", async () => {
    const six = await boot(adapter, "::1", false);
    let v6: ReturnType<typeof parse>;
    try {
      v6 = parse(
        await rawHttp(
          "::1",
          six.port,
          "GET /_nestrix/api/whoami HTTP/1.1\r\nHost: [::1]\r\nConnection: close\r\n\r\n",
        ),
      );
    } finally {
      await six.app.close();
    }
    const dual = await boot(adapter, "::", false);
    let mapped: ReturnType<typeof parse>;
    try {
      mapped = parse(
        await rawHttp(
          "127.0.0.1",
          dual.port,
          "GET /_nestrix/api/whoami HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        ),
      );
    } finally {
      await dual.app.close();
    }
    note(`Q7 ${adapter} ipv6`, {
      v6: v6.request.socketRemoteAddress,
      v6Host: v6.request.hostHeader,
      v6Hostname: v6.request.adapterHostname,
      mapped: mapped.request.socketRemoteAddress,
      mappedFamily: mapped.request.socketRemoteFamily,
    });
    expect(v6.request.socketRemoteAddress).toBe("::1");
    expect(v6.request.hostHeader).toBe("[::1]");
    // A loopback check has to accept the IPv4-mapped form too.
    expect(mapped.request.socketRemoteAddress).toBe("::ffff:127.0.0.1");
  });
});
