// The app map (P3-05): synthetic spans through the store, then `buildAppMap`. No globals other
// than the store singleton, which each test resets.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAppMap, MAX_MAP_NODES } from "../src/store/app-map.js";
import { createStoreProcessor } from "../src/store/processor.js";
import {
  getOrCreateStore,
  resetStoreForTests,
  type TraceStore,
} from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot } from "./store-helpers.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const CLIENT = 2;
const PRODUCER = 3;
const CONSUMER = 4;
const ERROR = 2;

let store: TraceStore;
let ingest: (...spans: ReadableSpan[]) => void;
let trace = 0;

beforeEach(() => {
  resetStoreForTests();
  store = getOrCreateStore({}, recordingDiagnostics());
  store.attach({});
  const processor = createStoreProcessor(store);
  ingest = (...spans) => {
    for (const s of spans) processor.onEnd(s);
    store.drainNow();
  };
  trace = 0;
});
afterEach(() => {
  resetStoreForTests();
});

/** One trace: a server root plus the given child spans. */
function request(
  children: {
    kind?: number;
    attributes?: Record<string, unknown>;
    durationMs?: number;
    error?: boolean;
  }[],
  rootStartMs = NOW - MIN,
  resource?: Record<string, unknown>,
): void {
  const t = ++trace;
  const root = serverRoot(t, {
    id: `${t.toString(16).padStart(8, "0")}00000000`,
    startMs: rootStartMs,
    ...(resource ? { resource } : {}),
  });
  const parent = { spanId: root.spanContext().spanId };
  ingest(
    root,
    ...children.map((c) =>
      fakeSpan({
        trace: t,
        parent,
        kind: c.kind ?? CLIENT,
        startMs: rootStartMs + 1,
        durationMs: c.durationMs ?? 5,
        attributes: c.attributes ?? {},
        status: { code: c.error ? ERROR : 0 },
        ...(resource ? { resource } : {}),
      }),
    ),
  );
}

const map = (windowMinutes = 15) => buildAppMap(store, windowMinutes, NOW);
const node = (m: ReturnType<typeof map>, id: string) =>
  m.nodes.find((n) => n.id === id);
const edge = (m: ReturnType<typeof map>, id: string) =>
  m.edges.find((e) => e.to === id);

describe("node kinds", () => {
  it("an empty store gives the app node alone", () => {
    const m = map();
    expect(m.nodes).toEqual([{ id: "app", kind: "app", name: "app" }]);
    expect(m.edges).toEqual([]);
    expect(m.toUnixMs - m.fromUnixMs).toBe(15 * MIN);
  });

  it("the app node is named by the resource's service.name, or the argument", () => {
    request([], NOW - MIN, { "service.name": "shop-api" });
    expect(map().nodes[0]).toMatchObject({ kind: "app", name: "shop-api" });
    expect(buildAppMap(store, 15, NOW, "given").nodes[0]?.name).toBe("given");
  });

  it("a database by system, server and namespace", () => {
    request([
      {
        attributes: {
          "db.system.name": "postgresql",
          "server.address": "localhost",
          "server.port": 5432,
          "db.namespace": "shop",
        },
      },
    ]);
    const m = map();
    expect(node(m, "db:postgresql:localhost:5432/shop")).toEqual({
      id: "db:postgresql:localhost:5432/shop",
      kind: "database",
      name: "postgresql shop",
      system: "postgresql",
    });
    expect(edge(m, "db:postgresql:localhost:5432/shop")).toMatchObject({
      from: "app",
      calls: 1,
      errors: 0,
    });
  });

  it("the legacy db.system attribute works, and two namespaces are two nodes", () => {
    request([
      { attributes: { "db.system": "mysql", "db.namespace": "a" } },
      { attributes: { "db.system": "mysql", "db.namespace": "b" } },
    ]);
    const ids = map()
      .nodes.map((n) => n.id)
      .sort();
    expect(ids).toEqual(["app", "db:mysql:/a", "db:mysql:/b"]);
  });

  it("Redis is a cache", () => {
    request([
      {
        attributes: {
          "db.system.name": "redis",
          "server.address": "cache.local",
          "server.port": 6379,
        },
      },
    ]);
    expect(node(map(), "cache:redis:cache.local:6379")).toMatchObject({
      kind: "cache",
      name: "redis",
      system: "redis",
    });
  });

  it("HTTP clients by host, the port shown only when not 80 or 443", () => {
    request([
      {
        attributes: {
          "http.request.method": "POST",
          "server.address": "api.stripe.com",
          "server.port": 443,
        },
      },
      {
        attributes: {
          "http.request.method": "GET",
          "server.address": "localhost",
          "server.port": 8080,
        },
      },
      { attributes: { "url.full": "http://plain.example/x" } },
    ]);
    const m = map();
    expect(node(m, "http:api.stripe.com")).toMatchObject({
      kind: "http",
      name: "api.stripe.com",
      system: "http",
    });
    expect(node(m, "http:localhost:8080")?.name).toBe("localhost:8080");
    expect(node(m, "http:plain.example")?.kind).toBe("http");
  });

  it("messaging by system and destination, producers included", () => {
    request([
      {
        kind: PRODUCER,
        attributes: {
          "messaging.system": "bullmq",
          "messaging.destination.name": "emails",
        },
      },
    ]);
    expect(node(map(), "queue:bullmq:emails")).toEqual({
      id: "queue:bullmq:emails",
      kind: "queue",
      name: "queue emails",
      system: "bullmq",
    });
  });

  it("anything else is other", () => {
    request([{ attributes: {} }, { attributes: { "server.address": "x.y" } }]);
    const m = map();
    expect(node(m, "other:unknown")?.kind).toBe("other");
    expect(node(m, "other:x.y")?.kind).toBe("other");
  });

  it("server, internal and consumer spans make no node", () => {
    request([
      { kind: 1, attributes: { "db.system.name": "postgresql" } },
      { kind: 0, attributes: { "db.system.name": "postgresql" } },
      { kind: CONSUMER, attributes: { "db.system.name": "postgresql" } },
    ]);
    expect(map().nodes).toHaveLength(1);
  });
});

describe("edges", () => {
  const pg = { "db.system.name": "postgresql", "db.namespace": "shop" };

  it("counts calls and errors across traces", () => {
    request([
      { attributes: pg },
      { attributes: pg, error: true },
      { attributes: pg },
    ]);
    request([{ attributes: pg, error: true }]);
    expect(edge(map(), "db:postgresql:/shop")).toMatchObject({
      calls: 4,
      errors: 2,
    });
  });

  it("p50 and p95 by nearest rank", () => {
    const durations = Array.from({ length: 20 }, (_, i) => i + 1);
    request(durations.map((durationMs) => ({ attributes: pg, durationMs })));
    expect(edge(map(), "db:postgresql:/shop")).toMatchObject({
      calls: 20,
      p50Ms: 10,
      p95Ms: 19,
    });
  });

  it("a single call has equal percentiles", () => {
    request([{ attributes: pg, durationMs: 42 }]);
    expect(edge(map(), "db:postgresql:/shop")).toMatchObject({
      p50Ms: 42,
      p95Ms: 42,
    });
  });

  it("targets are ordered by calls, busiest first", () => {
    request([
      { attributes: { "db.system.name": "mysql" } },
      { attributes: pg },
      { attributes: pg },
    ]);
    expect(map().nodes.map((n) => n.id)).toEqual([
      "app",
      "db:postgresql:/shop",
      "db:mysql:",
    ]);
  });
});

describe("window", () => {
  const pg = { "db.system.name": "postgresql" };

  it("leaves out traces whose root started before the window or after now", () => {
    request([{ attributes: pg }], NOW - 20 * MIN);
    request([{ attributes: pg }], NOW - 5 * MIN);
    request([{ attributes: pg }], NOW + 5 * MIN);
    expect(edge(map(15), "db:postgresql:")?.calls).toBe(1);
    expect(edge(map(60), "db:postgresql:")?.calls).toBe(2);
    expect(map(15).fromUnixMs).toBe(NOW - 15 * MIN);
  });

  it("a node outside the window is absent", () => {
    request([{ attributes: pg }], NOW - 30 * MIN);
    expect(map(15).nodes).toHaveLength(1);
    expect(map(60).nodes).toHaveLength(2);
  });
});

describe("bounds", () => {
  it("at most 200 nodes: the rest folds into one other node that keeps their calls", () => {
    // 250 hosts; host 0 is called 3 times so it must survive the cut.
    const spans = Array.from({ length: 250 }, (_, i) => ({
      attributes: {
        "http.request.method": "GET",
        "server.address": `h${String(i).padStart(3, "0")}.example`,
      },
    }));
    request(spans);
    request([spans[0] as (typeof spans)[number]]);
    request([spans[0] as (typeof spans)[number]]);
    const m = map();
    expect(m.nodes).toHaveLength(MAX_MAP_NODES);
    expect(m.edges).toHaveLength(MAX_MAP_NODES - 1);
    expect(node(m, "http:h000.example")).toBeDefined();
    const overflow = edge(m, "other:overflow");
    // 250 targets, 198 kept: 52 fold, one call each.
    expect(overflow?.calls).toBe(250 - (MAX_MAP_NODES - 2));
    expect(node(m, "other:overflow")?.kind).toBe("other");
    const total = m.edges.reduce((n, e) => n + e.calls, 0);
    expect(total).toBe(252);
  });

  it("exactly 199 targets need no overflow node", () => {
    request(
      Array.from({ length: MAX_MAP_NODES - 1 }, (_, i) => ({
        attributes: { "server.address": `h${i}` },
      })),
    );
    const m = map();
    expect(m.nodes).toHaveLength(MAX_MAP_NODES);
    expect(node(m, "other:overflow")).toBeUndefined();
  });

  it("no store gives the app node alone", () => {
    expect(buildAppMap(undefined, 15, NOW).nodes).toHaveLength(1);
  });
});
