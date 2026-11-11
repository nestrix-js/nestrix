// ioredis command spans against a real Redis 8 (backlog P3-01 items 4 and 7; D-60).
// Global state: a host-style provider with an in-memory exporter, the ALS context manager and W3C
// (outbound-helpers.ts). The ioredis integration is installed per describe block (process-wide
// subscription: the first installation's options apply, so each block disposes its own).
import { createRequire } from "node:module";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { redisText } from "../../src/integrations/channels.js";
import { setIntegrationFaultForTests } from "../../src/integrations/db-span.js";
import { installIntegrations } from "../../src/integrations/index.js";
import { recordingDiagnostics } from "../otel-helpers.js";
import { inParent, resolved, setupTestTracing } from "../outbound-helpers.js";
import {
  address,
  dbSpans,
  parentId,
  skipReason,
  tcpOpen,
  waitUntil,
} from "./helpers.js";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: structural use only
const Redis = require("ioredis") as any;

const reason = skipReason("redis");
const { exporter } = setupTestTracing();
const diagnostics = recordingDiagnostics();
const spans = () => dbSpans(exporter.getFinishedSpans());

function connect() {
  const a = address("redis");
  return new Redis({ host: a.host, port: a.port, lazyConnect: true });
}

describe("redisText", () => {
  it("keeps the command and the first argument as ioredis sanitised it, never values", () => {
    expect(redisText("GET", ["user:1"])).toBe("GET user:1");
    expect(redisText("SET", ["user:1", "?"])).toBe("SET user:1");
    expect(redisText("AUTH", ["?"])).toBe("AUTH");
    // Even if a library version did not sanitise AUTH or HELLO:
    expect(redisText("AUTH", ["hunter2"])).toBe("AUTH");
    expect(redisText("HELLO", ["3", "AUTH", "u", "p"])).toBe("HELLO");
    expect(redisText("PING", [])).toBe("PING");
    expect(redisText("GET", ["k".repeat(1000)])?.length).toBe(4 + 256);
  });
});

describe.skipIf(reason !== undefined)("ioredis against Redis 8", () => {
  // biome-ignore lint/suspicious/noExplicitAny: structural use only
  let redis: any;

  beforeAll(async () => {
    await waitUntil(() => tcpOpen(address("redis")), 30_000, "redis");
    await waitUntil(
      async () => {
        const r = connect();
        await r.connect();
        await r.ping();
        r.disconnect();
      },
      30_000,
      "redis",
    );
  }, 70_000);

  afterEach(() => {
    setIntegrationFaultForTests(undefined);
    exporter.reset();
  });

  describe("default options (root spans dropped)", () => {
    let dispose: () => void;
    beforeAll(async () => {
      dispose = installIntegrations(
        resolved({ integrations: { pg: false, ioredis: true } }),
        diagnostics,
      );
      redis = connect();
      // The handshake runs with no active span: no spans at all (D-60).
      await redis.connect();
    });
    afterAll(() => {
      redis?.disconnect();
      dispose?.();
    });

    it("the connection handshake and a command outside any trace produce no span", async () => {
      await redis.get("outside");
      expect(spans()).toEqual([]);
    });

    it("commands in a request: one CLIENT child span each, command and key only", async () => {
      const { parent, result } = await inParent(async () => {
        await redis.set("user:1", "secret-value");
        return redis.get("user:1");
      });
      expect(result).toBe("secret-value");
      const found = spans();
      expect(found.map((s) => [s.name, s.attributes["db.query.text"]])).toEqual(
        [
          ["SET", "SET user:1"],
          ["GET", "GET user:1"],
        ],
      );
      for (const s of found) {
        expect(s.kind).toBe(SpanKind.CLIENT);
        expect(parentId(s)).toBe(parent.spanContext().spanId);
        expect(s.attributes).toMatchObject({
          "db.system.name": "redis",
          "db.namespace": "0",
          "server.address": "127.0.0.1",
          "server.port": address("redis").port,
        });
      }
      expect(JSON.stringify(found.map((s) => s.attributes))).not.toContain(
        "secret-value",
      );
    });

    it("callback form and a pipeline (one span per command)", async () => {
      const { parent } = await inParent(async () => {
        await new Promise((res, rej) =>
          redis.incr("counter", (err: unknown, v: unknown) =>
            err ? rej(err) : res(v),
          ),
        );
        await redis.pipeline().set("p:1", "a").get("p:1").exec();
      });
      const found = spans();
      expect(found.map((s) => s.name)).toEqual(["INCR", "SET", "GET"]);
      for (const s of found)
        expect(parentId(s)).toBe(parent.spanContext().spanId);
    });

    it("an error: exception event and error status; the rejection reaches the caller", async () => {
      let caught: unknown;
      await inParent(async () => {
        await redis.set("str", "x");
        try {
          await redis.lpush("str", "y");
        } catch (error) {
          caught = error;
        }
      });
      expect(String((caught as Error).message)).toMatch(/WRONGTYPE/);
      const failed = spans().find((s) => s.name === "LPUSH");
      expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
      expect(failed?.events.map((e) => e.name)).toEqual(["exception"]);
    });

    it("a fault in every guarded body: results unchanged, failures counted, no span", async () => {
      setIntegrationFaultForTests((site) => {
        throw new Error(`injected at ${site}`);
      });
      const before = diagnostics.failures.length;
      const { result } = await inParent(async () => {
        await redis.set("f:1", "v");
        return redis.get("f:1");
      });
      expect(result).toBe("v");
      expect(spans()).toEqual([]);
      expect(diagnostics.failures.slice(before).map((f) => f.where)).toContain(
        "integrations.ioredis.command.start",
      );
    });
  });

  describe("rootSpans: true", () => {
    let dispose: () => void;
    beforeAll(() => {
      dispose = installIntegrations(
        resolved({ integrations: { pg: false, ioredis: { rootSpans: true } } }),
        diagnostics,
      );
    });
    afterAll(() => dispose?.());

    it("keeps commands that run outside any trace, as root spans", async () => {
      const r = connect();
      try {
        await r.connect();
        await r.get("outside");
      } finally {
        r.disconnect();
      }
      const roots = spans().filter((s) => s.parentSpanContext === undefined);
      // ioredis 6.0.0's handshake: HELLO, CLIENT SETINFO ×2, INFO; then the command.
      expect(roots.map((s) => s.name)).toEqual([
        "HELLO",
        "CLIENT",
        "CLIENT",
        "INFO",
        "GET",
      ]);
      expect(roots[0]?.attributes["db.query.text"]).toBe("HELLO");
    });
  });
});
