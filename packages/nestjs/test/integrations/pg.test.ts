// pg query spans against a real PostgreSQL 18 (backlog P3-01 items 2 and 7).
// Global state: a host-style provider with an in-memory exporter, the ALS context manager and W3C
// (outbound-helpers.ts), and the pg integration installed for the whole file. `pg` is loaded with
// createRequire, the same way the integration reaches it.
import { createRequire } from "node:module";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fault,
  setIntegrationFaultForTests,
} from "../../src/integrations/db-span.js";
import { installIntegrations } from "../../src/integrations/index.js";
import { pgStatus } from "../../src/integrations/pg.js";
import { SUPPRESS_TRACING_KEY } from "../../src/outbound/rules.js";
import { recordingDiagnostics } from "../otel-helpers.js";
import {
  closedPort,
  inParent,
  resolved,
  setupTestTracing,
  suppressed,
  unsampledParent,
} from "../outbound-helpers.js";
import {
  address,
  dbSpans,
  durationMs,
  parentId,
  skipReason,
  waitUntil,
} from "./helpers.js";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: pg is untyped here on purpose (structural use only)
const pg = require("pg") as any;
const Cursor = require("pg-cursor");
const QueryStream = require("pg-query-stream");

const reason = skipReason("postgres");
const { exporter, provider } = setupTestTracing();
const diagnostics = recordingDiagnostics();

function config(extra: Record<string, unknown> = {}) {
  const a = address("postgres");
  return {
    host: a.host,
    port: a.port,
    user: "postgres",
    database: "nestrix",
    ...extra,
  };
}

const spans = () => dbSpans(exporter.getFinishedSpans());

describe.skipIf(reason !== undefined)("pg against PostgreSQL 18", () => {
  let dispose: () => void;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  let client: any;

  beforeAll(async () => {
    dispose = installIntegrations(resolved(), diagnostics);
    await waitUntil(
      async () => {
        const c = new pg.Client(config());
        await c.connect();
        await c.end();
      },
      30_000,
      "postgres",
    );
    client = new pg.Client(config());
    await client.connect();
  }, 40_000);

  afterAll(async () => {
    await client?.end();
    dispose?.();
  });

  afterEach(() => {
    setIntegrationFaultForTests(undefined);
    exporter.reset();
  });

  it("wraps the pg this package resolves", () => {
    const status = pgStatus();
    expect(status.enabled).toBe(true);
    expect(status.resolved).toBe(require.resolve("pg"));
    expect(status.modules.map((m) => m.path)).toContain(require.resolve("pg"));
  });

  it("client promise: one CLIENT span, child of the caller, statement sanitised, no bind values", async () => {
    const { parent, result } = await inParent(() =>
      client.query(
        "SELECT $1::int AS n, 'secret' AS s FROM pg_class WHERE relname = 'x' LIMIT 1",
        [42],
      ),
    );
    expect(result.rowCount).toBeGreaterThanOrEqual(0);
    const [span, ...rest] = spans();
    expect(rest).toEqual([]);
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span && parentId(span)).toBe(parent.spanContext().spanId);
    expect(span?.name).toBe("SELECT pg_class");
    expect(span?.attributes).toMatchObject({
      "db.system.name": "postgresql",
      "db.query.text":
        "SELECT $1::int AS n, ? AS s FROM pg_class WHERE relname = ? LIMIT ?",
      "db.operation.name": "SELECT",
      "db.collection.name": "pg_class",
      "db.namespace": "nestrix",
      "server.address": "127.0.0.1",
      "server.port": address("postgres").port,
    });
    // The port is random (a container's), so leave it out of the bind-value check: a port such as
    // 34262 contains "42" without any bind value being recorded.
    const { "server.port": _port, ...noPort } = span?.attributes ?? {};
    expect(JSON.stringify(noPort)).not.toContain("42");
    expect(JSON.stringify(noPort)).not.toContain("secret");
  });

  it("client callback, both signatures: one span each, the callback runs once with pg's result", async () => {
    const { parent } = await inParent(
      () =>
        new Promise<void>((resolve, reject) => {
          client.query(
            "SELECT 1 AS one",
            (err: unknown, res: { rows: unknown[] }) => {
              if (err) return reject(err);
              expect(res.rows).toEqual([{ one: 1 }]);
              client.query(
                "SELECT $1::text AS t",
                ["v"],
                (err2: unknown, res2: { rows: unknown[] }) => {
                  if (err2) return reject(err2);
                  expect(res2.rows).toEqual([{ t: "v" }]);
                  resolve();
                },
              );
            },
          );
        }),
    );
    const found = spans();
    expect(found.map((s) => s.attributes["db.query.text"])).toEqual([
      "SELECT ? AS one",
      "SELECT $1::text AS t",
    ]);
    for (const s of found)
      expect(parentId(s)).toBe(parent.spanContext().spanId);
  });

  it("client error: exception event and error status; the rejection reaches the caller unchanged", async () => {
    let caught: unknown;
    await inParent(async () => {
      try {
        await client.query("SELECT * FROM no_such_table");
      } catch (error) {
        caught = error;
      }
    });
    expect((caught as { code?: string }).code).toBe("42P01");
    const [span] = spans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.map((e) => e.name)).toEqual(["exception"]);
    expect(span?.attributes["error.type"]).toBe("42P01");
  });

  it("a synchronous throw from pg (null query) reaches the caller once, with no span", async () => {
    expect(() => client.query(null)).toThrow(TypeError);
    expect(spans()).toEqual([]);
  });

  it("pg-cursor and pg-query-stream: one span each, ended through pg's protocol callbacks", async () => {
    const { parent } = await inParent(async () => {
      const cursor = client.query(
        new Cursor("SELECT generate_series(1, 5) AS n"),
      );
      const rows = await cursor.read(10);
      expect(rows).toHaveLength(5);
      await cursor.close();
      const fresh = new QueryStream("SELECT generate_series(1, 3) AS n");
      const listenersBefore = fresh
        .eventNames()
        .map((e: string | symbol) => [e, fresh.listenerCount(e)]);
      const stream = client.query(fresh);
      // Nestrix adds no listener of any kind to the stream (architecture §4.2).
      expect(
        stream
          .eventNames()
          .map((e: string | symbol) => [e, stream.listenerCount(e)]),
      ).toEqual(listenersBefore);
      const streamed: unknown[] = [];
      for await (const row of stream) streamed.push(row);
      expect(streamed).toHaveLength(3);
    });
    const found = spans();
    expect(found.map((s) => s.attributes["db.query.text"])).toEqual([
      "SELECT generate_series(?, ?) AS n",
      "SELECT generate_series(?, ?) AS n",
    ]);
    for (const s of found)
      expect(parentId(s)).toBe(parent.spanContext().spanId);
  });

  it("pool promise and callback: exactly one span per pool.query, child of the caller", async () => {
    const pool = new pg.Pool(config({ max: 2 }));
    try {
      const { parent } = await inParent(async () => {
        const r = await pool.query("SELECT 1 AS a");
        expect(r.rows).toEqual([{ a: 1 }]);
        await new Promise<void>((resolve, reject) =>
          pool.query(
            "SELECT $1::int AS b",
            [2],
            (err: unknown, res: { rows: unknown[] }) => {
              if (err) return reject(err);
              expect(res.rows).toEqual([{ b: 2 }]);
              resolve();
            },
          ),
        );
        await new Promise<void>((resolve, reject) =>
          pool.query("SELECT 3 AS c", (err: unknown) =>
            err ? reject(err) : resolve(),
          ),
        );
      });
      const found = spans();
      expect(found).toHaveLength(3);
      for (const s of found)
        expect(parentId(s)).toBe(parent.spanContext().spanId);
    } finally {
      await pool.end();
    }
  });

  it("pool span covers the query only, not the wait for a connection (D-59)", async () => {
    const pool = new pg.Pool(config({ max: 1 }));
    try {
      const held = await pool.connect();
      const started = Date.now();
      const { result } = await inParent(async () => {
        setTimeout(() => held.release(), 300);
        return pool.query("SELECT 1 AS waited");
      });
      expect(result.rows).toEqual([{ waited: 1 }]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
      const [span] = spans();
      expect(span && durationMs(span)).toBeLessThan(200);
    } finally {
      await pool.end();
    }
  });

  it("pool contention: two concurrent requests' queries land in their own traces", async () => {
    const pool = new pg.Pool(config({ max: 1 }));
    try {
      const request = (name: string) =>
        inParent(async () => {
          for (let i = 0; i < 3; i++)
            await pool.query(`SELECT '${name}' AS who, ${i} AS i`);
        });
      const [a, b] = await Promise.all([request("a"), request("b")]);
      const found = spans();
      expect(found).toHaveLength(6);
      const byParent = (p: typeof a.parent) =>
        found.filter((s) => parentId(s) === p.spanContext().spanId);
      expect(byParent(a.parent)).toHaveLength(3);
      expect(byParent(b.parent)).toHaveLength(3);
      for (const s of found)
        expect(s.spanContext().traceId).toBe(
          (parentId(s) === a.parent.spanContext().spanId
            ? a.parent
            : b.parent
          ).spanContext().traceId,
        );
    } finally {
      await pool.end();
    }
  });

  it("concurrent pool.query calls sharing one config object (named statement) keep one span each", async () => {
    const pool = new pg.Pool(config({ max: 1 }));
    const shared = {
      name: "shared-stmt",
      text: "SELECT $1::int AS v",
      values: [7],
    };
    try {
      const calls = await Promise.all(
        [0, 1, 2].map(() => inParent(() => pool.query(shared))),
      );
      for (const c of calls) expect(c.result.rows).toEqual([{ v: 7 }]);
      const found = spans();
      expect(found).toHaveLength(3);
      expect(new Set(found.map(parentId))).toEqual(
        new Set(calls.map((c) => c.parent.spanContext().spanId)),
      );
    } finally {
      await pool.end();
    }
  });

  it("two pools sharing one named-statement config object: each query is a child of its own request", async () => {
    const primary = new pg.Pool(config({ max: 1 }));
    const replica = new pg.Pool(config({ max: 1 }));
    const shared = {
      name: "two-pools-stmt",
      text: "SELECT $1::int AS v",
      values: [3],
    };
    try {
      const calls = await Promise.all(
        [primary, replica, primary, replica, primary, replica].map((pool) =>
          inParent(() => pool.query(shared)),
        ),
      );
      for (const c of calls) expect(c.result.rows).toEqual([{ v: 3 }]);
      const found = spans();
      expect(found).toHaveLength(6);
      const parents = found.map(parentId);
      for (const c of calls)
        expect(
          parents.filter((p) => p === c.parent.spanContext().spanId),
        ).toHaveLength(1);
    } finally {
      await primary.end();
      await replica.end();
    }
  });

  it("a checked-out client running the config while pool.query with it is queued: both are parented correctly", async () => {
    const pool = new pg.Pool(config({ max: 1 }));
    const stmt = {
      name: "client-and-pool-stmt",
      text: "SELECT $1::int AS v",
      values: [5],
    };
    try {
      const held = await pool.connect();
      const queued = inParent(() => pool.query(stmt));
      const direct = await inParent(() => held.query(stmt));
      held.release();
      const pooled = await queued;
      expect(direct.result.rows).toEqual([{ v: 5 }]);
      expect(pooled.result.rows).toEqual([{ v: 5 }]);
      const found = spans();
      expect(found).toHaveLength(2);
      expect(found.map(parentId).sort()).toEqual(
        [
          direct.parent.spanContext().spanId,
          pooled.parent.spanContext().spanId,
        ].sort(),
      );
    } finally {
      await pool.end();
    }
  });

  it("a pool that cannot connect: one error span under the caller, the rejection unchanged", async () => {
    const pool = new pg.Pool({ ...config(), port: await closedPort(), max: 1 });
    let caught: unknown;
    const { parent } = await inParent(async () => {
      try {
        await pool.query("SELECT 1");
      } catch (error) {
        caught = error;
      }
    });
    await pool.end();
    expect((caught as { code?: string }).code).toBe("ECONNREFUSED");
    const [span, ...rest] = spans();
    expect(rest).toEqual([]);
    expect(span && parentId(span)).toBe(parent.spanContext().spanId);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("ECONNREFUSED");
  });

  it("queries under the suppress-tracing key produce no span", async () => {
    const { parent } = await inParent(() => undefined);
    await context.with(
      suppressed(trace.setSpan(context.active(), parent)),
      async () => {
        await client.query("SELECT 1");
        const pool = new pg.Pool(config({ max: 1 }));
        await pool.query("SELECT 1");
        await pool.end();
      },
    );
    expect(spans()).toEqual([]);
  });

  describe("no active span (D-115)", () => {
    it("client and pool queries in every form get no span; results unchanged", async () => {
      const pool = new pg.Pool(config({ max: 1 }));
      try {
        const a = await client.query("SELECT 1 AS a");
        const b = await new Promise<{ rows: unknown[] }>((resolve, reject) =>
          client.query("SELECT $1::int AS b", [2], (e: unknown, r: never) =>
            e ? reject(e) : resolve(r),
          ),
        );
        const rows: unknown[] = [];
        for await (const row of client.query(new QueryStream("SELECT 3 AS c")))
          rows.push(row);
        const d = await pool.query("SELECT 4 AS d");
        const e = await new Promise<{ rows: unknown[] }>((resolve, reject) =>
          pool.query("SELECT 5 AS e", (err: unknown, r: never) =>
            err ? reject(err) : resolve(r),
          ),
        );
        expect(a.rows).toEqual([{ a: 1 }]);
        expect(b.rows).toEqual([{ b: 2 }]);
        expect(rows).toEqual([{ c: 3 }]);
        expect(d.rows).toEqual([{ d: 4 }]);
        expect(e.rows).toEqual([{ e: 5 }]);
      } finally {
        await pool.end();
      }
      expect(spans()).toEqual([]);
    });

    it("the same query inside a request span is still its child", async () => {
      await client.query("SELECT 1 AS outside");
      const { parent } = await inParent(() =>
        client.query("SELECT 1 AS inside"),
      );
      const [span, ...rest] = spans();
      expect(rest).toEqual([]);
      expect(span && parentId(span)).toBe(parent.spanContext().spanId);
    });

    it("a pool that cannot connect, outside a trace: no span, the rejection unchanged", async () => {
      const pool = new pg.Pool({
        ...config(),
        port: await closedPort(),
        max: 1,
      });
      let caught: unknown;
      try {
        await pool.query("SELECT 1");
      } catch (error) {
        caught = error;
      }
      await pool.end();
      expect((caught as { code?: string }).code).toBe("ECONNREFUSED");
      expect(spans()).toEqual([]);
    });

    it("an untraced pool call served from a traced caller's release is not parented to it", async () => {
      const pool = new pg.Pool(config({ max: 1 }));
      try {
        const held = await pool.connect();
        // Queued with no active span; served when the traced caller below releases.
        const untraced = pool.query("SELECT 2 AS untraced");
        const { parent } = await inParent(async () => {
          await held.query("SELECT 1 AS traced");
          held.release();
        });
        expect((await untraced).rows).toEqual([{ untraced: 2 }]);
        const found = spans();
        expect(found.map((s) => s.attributes["db.query.text"])).toEqual([
          "SELECT ? AS traced",
        ]);
        expect(found[0] && parentId(found[0])).toBe(
          parent.spanContext().spanId,
        );
      } finally {
        await pool.end();
      }
    });

    it("a queued pool.connect(cb) from an untraced caller runs in its own context, not the releaser's", async () => {
      const pool = new pg.Pool(config({ max: 1 }));
      try {
        const held = await pool.connect();
        const untraced = new Promise<unknown[]>((resolve, reject) =>
          pool.connect(
            (
              e: unknown,
              c: { query: (q: string) => Promise<{ rows: unknown[] }> },
              release: () => void,
            ) => {
              if (e) return reject(e);
              c.query("SELECT 2 AS untraced").then((r: { rows: unknown[] }) => {
                release();
                resolve(r.rows);
              }, reject);
            },
          ),
        );
        const { parent } = await inParent(async () => {
          await held.query("SELECT 1 AS traced");
          held.release();
        });
        expect(await untraced).toEqual([{ untraced: 2 }]);
        const found = spans();
        expect(found.map((s) => s.attributes["db.query.text"])).toEqual([
          "SELECT ? AS traced",
        ]);
        expect(found[0] && parentId(found[0])).toBe(
          parent.spanContext().spanId,
        );
      } finally {
        await pool.end();
      }
    });

    it("a queued pool.connect(cb) from a traced caller: its query is a child of its own caller's span", async () => {
      const pool = new pg.Pool(config({ max: 1 }));
      try {
        const held = await pool.connect();
        const own = trace.getTracer("test").startSpan("own-caller");
        const ownContext = trace.setSpan(context.active(), own);
        const queued = context.with(
          ownContext,
          () =>
            new Promise<unknown[]>((resolve, reject) =>
              pool.connect(function (
                this: unknown,
                e: unknown,
                c: { query: (q: string) => Promise<{ rows: unknown[] }> },
                release: () => void,
              ) {
                if (e) return reject(e);
                c.query("SELECT 3 AS queued").then((r: { rows: unknown[] }) => {
                  release();
                  resolve(r.rows);
                }, reject);
              }),
            ),
        );
        const { parent } = await inParent(async () => {
          await held.query("SELECT 1 AS releaser");
          held.release();
        });
        expect(await queued).toEqual([{ queued: 3 }]);
        own.end();
        const byText = new Map(
          spans().map((s) => [s.attributes["db.query.text"], s]),
        );
        const releaser = byText.get("SELECT ? AS releaser");
        const mine = byText.get("SELECT ? AS queued");
        expect(releaser && parentId(releaser)).toBe(
          parent.spanContext().spanId,
        );
        expect(mine && parentId(mine)).toBe(own.spanContext().spanId);
      } finally {
        await pool.end();
      }
    });

    it("a client callback outside a trace runs in the caller's context, not the socket's", async () => {
      // Connected inside a span, so pg's socket events run in that span's async context.
      const traced = new pg.Client(config());
      await inParent(() => traced.connect());
      exporter.reset();
      try {
        const rows = await new Promise((resolve, reject) =>
          traced.query("SELECT 1 AS outer", (e: unknown) => {
            if (e) return reject(e);
            traced.query("SELECT 2 AS inner", (e2: unknown, r: never) =>
              e2 ? reject(e2) : resolve((r as { rows: unknown[] }).rows),
            );
          }),
        );
        expect(rows).toEqual([{ inner: 2 }]);
      } finally {
        await traced.end();
      }
      expect(spans()).toEqual([]);
    });

    it("a context whose lookup throws: the query runs unchanged, the failure is counted", async () => {
      const before = diagnostics.failures.length;
      const root = context.active();
      // Answers the suppress-tracing lookup, throws on the active-span lookup (the D-115 check).
      const hostile = {
        getValue: (key: symbol) => {
          if (key === SUPPRESS_TRACING_KEY) return undefined;
          throw new Error("hostile context");
        },
        setValue: () => hostile,
        deleteValue: () => hostile,
      };
      const pool = new pg.Pool(config({ max: 1 }));
      try {
        const r = await context.with(hostile as never, () =>
          client.query("SELECT 7 AS h"),
        );
        const p = await context.with(hostile as never, () =>
          pool.query("SELECT 8 AS h"),
        );
        expect(r.rows).toEqual([{ h: 7 }]);
        expect(p.rows).toEqual([{ h: 8 }]);
      } finally {
        await pool.end();
      }
      expect(context.active()).toBe(root);
      expect(spans()).toEqual([]);
      expect(diagnostics.failures.slice(before).map((f) => f.where)).toContain(
        "integrations.pg.client.query",
      );
    });

    describe("rootSpans: true", () => {
      beforeAll(() => {
        dispose();
        dispose = installIntegrations(
          resolved({ integrations: { pg: { rootSpans: true } } }),
          diagnostics,
        );
      });
      afterAll(() => {
        dispose();
        dispose = installIntegrations(resolved(), diagnostics);
      });

      it("keeps a query with no active span, as a root span", async () => {
        await client.query("SELECT 1 AS rooted");
        const [span, ...rest] = spans();
        expect(rest).toEqual([]);
        expect(span?.name).toBe("SELECT");
        expect(span?.parentSpanContext).toBeUndefined();
      });

      it("an unsampled parent: the query exports nothing", async () => {
        await context.with(unsampledParent(), () =>
          client.query("SELECT 1 AS unsampled"),
        );
        expect(spans()).toEqual([]);
      });

      it("keeps the failure span of a pool that cannot connect, as a root", async () => {
        const pool = new pg.Pool({
          ...config(),
          port: await closedPort(),
          max: 1,
        });
        await pool.query("SELECT 1").catch(() => undefined);
        await pool.end();
        const [span, ...rest] = spans();
        expect(rest).toEqual([]);
        expect(span?.parentSpanContext).toBeUndefined();
        expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      });
    });

    describe("rootSpans: true with poolWaitThresholdMillis", () => {
      let restore: () => void;
      beforeAll(() => {
        dispose();
        dispose = () => undefined;
      });
      afterAll(() => {
        dispose = installIntegrations(resolved(), diagnostics);
      });

      async function waitSpans(threshold: number, waitMillis: number) {
        restore = installIntegrations(
          resolved({
            integrations: {
              pg: { rootSpans: true, poolWaitThresholdMillis: threshold },
            },
          }),
          diagnostics,
        );
        const pool = new pg.Pool(config({ max: 1 }));
        try {
          const held = await pool.connect();
          setTimeout(() => held.release(), waitMillis);
          await inParent(async () => {
            const c = await pool.connect();
            c.release();
          });
        } finally {
          await pool.end();
          restore();
        }
        return exporter
          .getFinishedSpans()
          .filter((s) => s.name === "pg.pool.connect");
      }

      it("the wait span appears inside a trace above the threshold", async () => {
        expect(await waitSpans(20, 100)).toHaveLength(1);
      });

      it("and not below it", async () => {
        expect(await waitSpans(5000, 100)).toEqual([]);
      });
    });
  });

  it("a fault in every guarded body: results unchanged, failures counted, no span", async () => {
    const before = diagnostics.failures.length;
    setIntegrationFaultForTests((site) => {
      throw new Error(`injected at ${site}`);
    });
    const pool = new pg.Pool(config({ max: 1 }));
    try {
      const r1 = await inParent(() => client.query("SELECT $1::int AS x", [1]));
      const r2 = await inParent(() => pool.query("SELECT 2 AS y"));
      const rows: unknown[] = [];
      for await (const row of client.query(new QueryStream("SELECT 3 AS z")))
        rows.push(row);
      let caught: unknown;
      try {
        await client.query("SELECT * FROM no_such_table");
      } catch (error) {
        caught = error;
      }
      expect(r1.result.rows).toEqual([{ x: 1 }]);
      expect(r2.result.rows).toEqual([{ y: 2 }]);
      expect(rows).toEqual([{ z: 3 }]);
      expect((caught as { code?: string }).code).toBe("42P01");
    } finally {
      await pool.end();
    }
    expect(spans()).toEqual([]);
    const sites = diagnostics.failures.slice(before).map((f) => f.where);
    expect(sites).toContain("integrations.pg.client.query");
    expect(sites).toContain("integrations.pg.pool.query");
    // `fault` itself is the injection point: prove it was the one throwing.
    expect(() => fault("x")).toThrow("injected at x");
  });

  it("a throwing tracer does not change query results", async () => {
    // Inside a trace (a parent from the working provider), so the integration calls the tracer.
    const parent = trace.getTracer("test").startSpan("parent");
    const inTrace = trace.setSpan(context.active(), parent);
    trace.disable();
    const throwing = {
      getTracer: () => ({
        startSpan: () => {
          throw new Error("tracer down");
        },
        startActiveSpan: () => {
          throw new Error("tracer down");
        },
      }),
    };
    trace.setGlobalTracerProvider(throwing as never);
    const before = diagnostics.failures.length;
    const pool = new pg.Pool(config({ max: 1 }));
    try {
      const { a, b, c } = await context.with(inTrace, async () => ({
        a: await client.query("SELECT $1::int AS x", [5]),
        b: await pool.query("SELECT 6 AS y"),
        c: await new Promise((resolve, reject) =>
          client.query("SELECT 7 AS z", (e: unknown, r: unknown) =>
            e ? reject(e) : resolve(r),
          ),
        ),
      }));
      expect(a.rows).toEqual([{ x: 5 }]);
      expect(b.rows).toEqual([{ y: 6 }]);
      expect((c as { rows: unknown[] }).rows).toEqual([{ z: 7 }]);
    } finally {
      await pool.end();
      trace.disable();
      trace.setGlobalTracerProvider(provider);
    }
    expect(diagnostics.failures.length).toBeGreaterThan(before);
  });
});
