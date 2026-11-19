// mysql2 query spans against a real MySQL 8.4 (backlog P3-01 items 3 and 7).
// Global state: a host-style provider with an in-memory exporter, the ALS context manager and W3C
// (outbound-helpers.ts); the mysql2 integration subscribed for the whole file.
import { createRequire } from "node:module";
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setIntegrationFaultForTests } from "../../src/integrations/db-span.js";
import { installIntegrations } from "../../src/integrations/index.js";
import { SUPPRESS_TRACING_KEY } from "../../src/outbound/rules.js";
import { recordingDiagnostics } from "../otel-helpers.js";
import { inParent, resolved, setupTestTracing } from "../outbound-helpers.js";
import {
  address,
  dbSpans,
  parentId,
  skipReason,
  waitUntil,
} from "./helpers.js";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: structural use only
const mysql = require("mysql2") as any;
// biome-ignore lint/suspicious/noExplicitAny: structural use only
const mysqlPromise = require("mysql2/promise") as any;

const reason = skipReason("mysql");
const { exporter } = setupTestTracing();
const diagnostics = recordingDiagnostics();
const spans = () => dbSpans(exporter.getFinishedSpans());

function config(extra: Record<string, unknown> = {}) {
  const a = address("mysql");
  return {
    host: a.host,
    port: a.port,
    user: "root",
    database: "nestrix",
    ...extra,
  };
}

const cb =
  // biome-ignore lint/suspicious/noExplicitAny: callback plumbing
    (resolve: (v: any) => void, reject: (e: unknown) => void) =>
    (err: unknown, rows: unknown) =>
      err ? reject(err) : resolve(rows);

describe.skipIf(reason !== undefined)("mysql2 against MySQL 8.4", () => {
  let dispose: () => void;
  // biome-ignore lint/suspicious/noExplicitAny: structural use only
  let conn: any;

  beforeAll(async () => {
    await waitUntil(
      async () => {
        const c = await mysqlPromise.createConnection(config());
        await c.end();
      },
      60_000,
      "mysql",
    );
    dispose = installIntegrations(
      resolved({ integrations: { pg: false, mysql2: true } }),
      diagnostics,
    );
    conn = mysql.createConnection(config());
    await new Promise((resolve, reject) => conn.connect(cb(resolve, reject)));
  }, 70_000);

  afterAll(async () => {
    if (conn) await new Promise((resolve) => conn.end(resolve));
    dispose?.();
  });

  afterEach(() => {
    setIntegrationFaultForTests(undefined);
    exporter.reset();
  });

  it("query and execute, connection and pool, callback and promise: one child span each, no values", async () => {
    const pool = mysql.createPool(config({ connectionLimit: 2 }));
    try {
      const { parent } = await inParent(async () => {
        await new Promise((res, rej) =>
          conn.query("SELECT ? AS a", ["secret-q"], cb(res, rej)),
        );
        await new Promise((res, rej) =>
          conn.execute("SELECT ? AS b", ["secret-e"], cb(res, rej)),
        );
        await conn.promise().query("SELECT 1 AS c");
        await new Promise((res, rej) =>
          pool.query("SELECT 'secret-p' AS d", cb(res, rej)),
        );
        await pool.promise().execute("SELECT ? AS e", [5]);
      });
      const found = spans();
      expect(found.map((s) => s.attributes["db.query.text"])).toEqual([
        "SELECT ? AS a",
        "SELECT ? AS b",
        "SELECT ? AS c",
        "SELECT ? AS d",
        "SELECT ? AS e",
      ]);
      for (const s of found) {
        expect(s.kind).toBe(SpanKind.CLIENT);
        expect(parentId(s)).toBe(parent.spanContext().spanId);
        expect(s.name).toBe("SELECT");
        expect(s.attributes).toMatchObject({
          "db.system.name": "mysql",
          "db.operation.name": "SELECT",
          "db.namespace": "nestrix",
          "server.address": "127.0.0.1",
          "server.port": address("mysql").port,
        });
      }
      expect(JSON.stringify(found.map((s) => s.attributes))).not.toMatch(
        /secret/,
      );
    } finally {
      await pool.promise().end();
    }
  });

  it("an error: exception event and error status; the caller gets mysql2's error", async () => {
    let caught: unknown;
    await inParent(async () => {
      try {
        await conn.promise().query("SELECT * FROM no_such_table");
      } catch (error) {
        caught = error;
      }
    });
    expect((caught as { code?: string }).code).toBe("ER_NO_SUCH_TABLE");
    const [span] = spans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("ER_NO_SUCH_TABLE");
    expect(span?.name).toBe("SELECT no_such_table");
  });

  it("pool contention: a queued caller's queries land in its own trace (pool:connect fix)", async () => {
    const pool = mysql.createPool(config({ connectionLimit: 1 }));
    try {
      const request = (who: string) =>
        inParent(async () => {
          for (let i = 0; i < 3; i++) {
            await new Promise((res, rej) =>
              pool.query(`SELECT '${who}' AS w, ${i} AS i`, cb(res, rej)),
            );
          }
        });
      const [a, b] = await Promise.all([request("a"), request("b")]);
      const found = spans();
      expect(found).toHaveLength(6);
      const under = (p: typeof a.parent) =>
        found.filter((s) => parentId(s) === p.spanContext().spanId).length;
      expect([under(a.parent), under(b.parent)]).toEqual([3, 3]);
    } finally {
      await pool.promise().end();
    }
  });

  it("a fault in every guarded body: results unchanged, failures counted, no span", async () => {
    setIntegrationFaultForTests((site) => {
      throw new Error(`injected at ${site}`);
    });
    const pool = mysql.createPool(config({ connectionLimit: 1 }));
    const before = diagnostics.failures.length;
    try {
      const { result } = await inParent(async () => {
        const [rows] = await pool.promise().query("SELECT 41 + 1 AS v");
        return rows;
      });
      expect(result).toEqual([{ v: 42 }]);
      let caught: unknown;
      try {
        await conn.promise().execute("SELECT * FROM no_such_table");
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe("ER_NO_SUCH_TABLE");
    } finally {
      await pool.promise().end();
    }
    expect(spans()).toEqual([]);
    const sites = new Set(
      diagnostics.failures.slice(before).map((f) => f.where),
    );
    expect(sites).toContain("integrations.mysql2.query.start");
    expect(sites).toContain("integrations.mysql2.execute.start");
    expect(sites).toContain("integrations.mysql2.pool.start");
  });

  describe("no active span (D-115)", () => {
    it("query and execute, connection and pool: no span; results unchanged", async () => {
      const pool = mysql.createPool(config({ connectionLimit: 1 }));
      try {
        const a = await new Promise((res, rej) =>
          conn.query("SELECT 1 AS a", cb(res, rej)),
        );
        const [b] = await conn.promise().execute("SELECT ? AS b", [2]);
        const [c] = await pool.promise().query("SELECT 3 AS c");
        expect(a).toEqual([{ a: 1 }]);
        expect(b).toEqual([{ b: 2 }]);
        expect(c).toEqual([{ c: 3 }]);
      } finally {
        await pool.promise().end();
      }
      expect(spans()).toEqual([]);
    });

    it("the same query inside a request span is still its child", async () => {
      await conn.promise().query("SELECT 1 AS same");
      const { parent } = await inParent(() =>
        conn.promise().query("SELECT 1 AS same"),
      );
      const [span, ...rest] = spans();
      expect(rest).toEqual([]);
      expect(span && parentId(span)).toBe(parent.spanContext().spanId);
    });

    it("an untraced pool caller served from a traced caller's release is not parented to it", async () => {
      const pool = mysql.createPool(config({ connectionLimit: 1 }));
      try {
        const held = await new Promise<{
          release(): void;
          query: (...args: unknown[]) => unknown;
        }>((res, rej) => pool.getConnection(cb(res, rej)));
        const untraced = new Promise((res, rej) =>
          pool.query("SELECT 2 AS untraced", cb(res, rej)),
        );
        const { parent } = await inParent(async () => {
          await new Promise((res, rej) =>
            held.query("SELECT 1 AS traced", cb(res, rej)),
          );
          held.release();
        });
        expect(await untraced).toEqual([{ untraced: 2 }]);
        const found = spans();
        expect(found.map((x) => x.attributes["db.query.text"])).toEqual([
          "SELECT ? AS traced",
        ]);
        expect(found[0] && parentId(found[0])).toBe(
          parent.spanContext().spanId,
        );
      } finally {
        await pool.promise().end();
      }
    });

    it("a context whose lookup throws: the query runs unchanged, the failure is counted", async () => {
      const before = diagnostics.failures.length;
      const hostile = {
        getValue: (key: symbol) => {
          if (key === SUPPRESS_TRACING_KEY) return undefined;
          throw new Error("hostile context");
        },
        setValue: () => hostile,
        deleteValue: () => hostile,
      };
      const rows = await context.with(
        hostile as never,
        () =>
          new Promise((res, rej) => conn.query("SELECT 9 AS h", cb(res, rej))),
      );
      expect(rows).toEqual([{ h: 9 }]);
      expect(spans()).toEqual([]);
      expect(diagnostics.failures.slice(before).map((f) => f.where)).toContain(
        "integrations.mysql2.query.start",
      );
    });

    describe("rootSpans: true", () => {
      beforeAll(() => {
        dispose();
        dispose = installIntegrations(
          resolved({
            integrations: { pg: false, mysql2: { rootSpans: true } },
          }),
          diagnostics,
        );
      });
      afterAll(() => {
        dispose();
        dispose = installIntegrations(
          resolved({ integrations: { pg: false, mysql2: true } }),
          diagnostics,
        );
      });

      it("keeps a query with no active span, as a root span", async () => {
        await conn.promise().query("SELECT 1 AS rooted");
        const [span, ...rest] = spans();
        expect(rest).toEqual([]);
        expect(span?.name).toBe("SELECT");
        expect(span?.parentSpanContext).toBeUndefined();
      });
    });
  });
});
