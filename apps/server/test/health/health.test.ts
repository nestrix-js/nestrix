// /livez and /readyz (#32): no credential, no redirect, no limiter, no self-tracing, and 503 once
// shutdown begins. The database cases are in readiness.test.ts.
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { type BeforeApplicationShutdown, Injectable } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/bootstrap.js";
import { INGEST_SINK } from "../../src/ingest/tokens.js";
import { ADMIN_PW, postLogin, startAuthServer } from "../auth/helpers.js";
import {
  RecordingSink,
  type TestServer,
  testConfig,
} from "../ingest/helpers.js";

const exporter = new InMemorySpanExporter();
let server: TestServer;

beforeAll(async () => {
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    }),
  );
  server = await startAuthServer();
});
afterAll(async () => {
  await server?.close();
  trace.disable();
});

describe("health routes", () => {
  it("/livez answers 200 with no credential and no redirect", async () => {
    const res = await fetch(`${server.baseUrl}/livez`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
  });

  it("/readyz answers 200 when there is nothing to wait for", async () => {
    const res = await fetch(`${server.baseUrl}/readyz`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers HEAD, a trailing slash and any case; refuses writes", async () => {
    expect(
      (await fetch(`${server.baseUrl}/readyz`, { method: "HEAD" })).status,
    ).toBe(200);
    expect((await fetch(`${server.baseUrl}/LIVEZ/`)).status).toBe(200);
    const post = await fetch(`${server.baseUrl}/livez`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("emits no CORS headers and takes a query string", async () => {
    const res = await fetch(`${server.baseUrl}/readyz?x=1`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(
      [...res.headers.keys()].filter((h) => h.startsWith("access-control-")),
    ).toEqual([]);
  });

  it("other paths still need the login (the default deny is untouched)", async () => {
    for (const path of ["/health", "/healthz", "/livez/x", "/api/v1/meta"]) {
      const res = await fetch(`${server.baseUrl}${path}`, {
        redirect: "manual",
      });
      expect(res.status, path).not.toBe(200);
    }
  });

  it("does not use the login limiter's budget", async () => {
    // The limiter allows 5 attempts a minute per client; probes are far more frequent.
    for (let i = 0; i < 30; i++) {
      expect((await fetch(`${server.baseUrl}/readyz`)).status).toBe(200);
      expect((await fetch(`${server.baseUrl}/livez`)).status).toBe(200);
    }
    const login = await postLogin(server.baseUrl, ADMIN_PW);
    expect(login.status).toBe(303);
  });

  it("creates no server span", async () => {
    exporter.reset();
    await fetch(`${server.baseUrl}/livez`);
    await fetch(`${server.baseUrl}/readyz`);
    await fetch(`${server.baseUrl}/not-a-route`);
    await new Promise((r) => setTimeout(r, 50));
    const paths = exporter
      .getFinishedSpans()
      .map((s) => String(s.attributes["url.path"] ?? ""));
    expect(paths).toContain("/not-a-route");
    expect(paths.filter((p) => /^\/(livez|readyz)/.test(p))).toEqual([]);
  });
});

// Module-level, not static members: a decorated class's methods see the undecorated binding.
const gate = { reached: () => {}, release: () => {}, open: false };

@Injectable()
class HoldShutdown implements BeforeApplicationShutdown {
  async beforeApplicationShutdown(): Promise<void> {
    gate.reached();
    if (gate.open) return;
    await new Promise<void>((resolve) => {
      gate.release = () => {
        gate.open = true;
        resolve();
      };
    });
  }
}

describe("shutdown", () => {
  it("/readyz answers 503 once shutdown begins while /livez stays 200", async () => {
    const config = testConfig();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config, { inMemory: true })],
      providers: [HoldShutdown],
    })
      .overrideProvider(INGEST_SINK)
      .useValue(new RecordingSink())
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app, config);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(`${base}/readyz`)).status).toBe(200);

      const reached = new Promise<void>((resolve) => {
        gate.reached = resolve;
      });
      const closing = app.close();
      await reached; // the shutdown hooks are running, the HTTP server is still open
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: "unavailable",
        reason: "shutting-down",
      });
      expect((await fetch(`${base}/livez`)).status).toBe(200);
      gate.release();
      await closing;
    } finally {
      gate.release();
      app.getHttpServer().closeAllConnections();
      await app.close().catch(() => undefined);
    }
  });
});
