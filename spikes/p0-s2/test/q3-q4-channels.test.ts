import { beforeAll, describe, expect, it } from "vitest";
import {
  childrenOf,
  dbs,
  type FixtureResult,
  nodeBinaries,
  requireBuilt,
  runFixture,
  SPAN_KIND_CLIENT,
  STATUS_ERROR,
  skipNote,
} from "./helpers.js";

// Q3 (mysql2 TracingChannels) and Q4 (ioredis TracingChannels), subscribed from module
// initialisation in the ESM and CJS fixture apps.

requireBuilt();

interface Tagged {
  spanId: string;
  result: Record<string, unknown>;
}

const body = (r: FixtureResult, s: string) => {
  expect(r.responses[s]?.status, JSON.stringify(r.responses[s])).toBe(200);
  return r.responses[s]?.body as Tagged;
};

describe.skipIf(!dbs.mysql)(skipNote("Q3 mysql2", !!dbs.mysql), () => {
  describe.each(nodeBinaries())("Node $label", ({ bin }) => {
    let esm: FixtureResult;
    let cjs: FixtureResult;
    beforeAll(async () => {
      const [e, c] = await Promise.all([
        runFixture("esm", ["mysql", "mysql-contention"], { node: bin }),
        runFixture("cjs", ["mysql"], { node: bin }),
      ]);
      expect(e.result, e.stderr).toBeDefined();
      expect(c.result, c.stderr).toBeDefined();
      esm = e.result as FixtureResult;
      cjs = c.result as FixtureResult;
    });

    it("query and execute, on a pool and on a connection, callback and promise API: one span each, child of the caller", () => {
      const h = body(esm, "mysql");
      const kids = childrenOf(esm.spans, h.spanId).sort(
        (a, b) => a.startMs - b.startMs,
      );
      expect(kids.map((s) => s.name)).toEqual([
        "mysql2.query SELECT", // pool.query
        "mysql2.execute SELECT", // pool.execute
        "mysql2.query SELECT", // conn.query
        "mysql2.execute SELECT", // conn.execute
        "mysql2.query SELECT", // promise pool.query
        "mysql2.query SELECT", // failing query
      ]);
      for (const s of kids) expect(s.kind).toBe(SPAN_KIND_CLIENT);
    });

    it("context carries statement text, database, server address/port and bind values; the error comes on ctx.error", () => {
      const h = body(esm, "mysql");
      const kids = childrenOf(esm.spans, h.spanId).sort(
        (a, b) => a.startMs - b.startMs,
      );
      for (const s of kids) {
        expect(s.attributes["nestrix.ctx_keys"]).toBe(
          "database,query,serverAddress,serverPort,values",
        );
        expect(s.attributes["db.namespace"]).toBe("nestrix");
      }
      expect(kids[1]?.attributes["nestrix.values_present"]).toBe(true);
      const failed = kids[5];
      expect(failed?.status.code).toBe(STATUS_ERROR);
      expect(failed?.status.message).toMatch(/doesn't exist/);
      expect(failed?.attributes["db.query.text"]).toBe(
        "SELECT * FROM nestrix_missing_table",
      );
    });

    it("pool contention: with the pool:connect bracket, the queued caller's query is parented to the caller", () => {
      const c = esm.responses["mysql-contention"]?.body as {
        a: string;
        b: string;
      };
      expect(childrenOf(esm.spans, c.a)).toHaveLength(1);
      expect(childrenOf(esm.spans, c.b)).toHaveLength(1);
    });

    it("CJS app: same spans, same parent", () => {
      const h = body(cjs, "mysql");
      const kids = childrenOf(cjs.spans, h.spanId);
      expect(kids.map((s) => s.name).sort()).toEqual([
        "mysql2.execute SELECT",
        "mysql2.query SELECT",
      ]);
    });
  });

  it("finding: without the bracket, mysql2:query is published in the releasing caller's context (wrong parent)", async () => {
    const r = (
      await runFixture("esm", ["mysql-contention"], {
        env: { NESTRIX_MYSQL_POOL_PARENT: "0" },
      })
    ).result as FixtureResult;
    const c = r.responses["mysql-contention"]?.body as { a: string; b: string };
    // Both queries end up under handler A; handler B has no child at all.
    expect(childrenOf(r.spans, c.a)).toHaveLength(2);
    expect(childrenOf(r.spans, c.b)).toHaveLength(0);
  });

  it("F4 limitation: the bracket covers only queries started synchronously in the pool callback; later work is still misparented", async () => {
    const r = (await runFixture("esm", ["mysql-callback-later"]))
      .result as FixtureResult;
    const c = r.responses["mysql-callback-later"]?.body as {
      a: string;
      b: string;
    };
    expect(childrenOf(r.spans, c.a)).toHaveLength(2);
    expect(childrenOf(r.spans, c.b)).toHaveLength(0);
  });

  it("F4 fuller fix: asyncStart.bindStore on the context manager's AsyncLocalStorage parents later work correctly", async () => {
    const r = (
      await runFixture("esm", ["mysql-callback-later", "mysql-contention"], {
        env: { NESTRIX_MYSQL_POOL_BINDSTORE: "1" },
      })
    ).result as FixtureResult;
    expect(r.failures).toEqual({});
    for (const s of ["mysql-callback-later", "mysql-contention"]) {
      const c = r.responses[s]?.body as { a: string; b: string };
      expect(childrenOf(r.spans, c.a), s).toHaveLength(1);
      expect(childrenOf(r.spans, c.b), s).toHaveLength(1);
    }
  });
});

describe.skipIf(!dbs.redis)(skipNote("Q4 ioredis", !!dbs.redis), () => {
  describe.each(nodeBinaries())("Node $label", ({ bin }) => {
    let esm: FixtureResult;
    let cjs: FixtureResult;
    beforeAll(async () => {
      const [e, c] = await Promise.all([
        runFixture("esm", ["redis", "redis5"], { node: bin }),
        runFixture("cjs", ["redis"], { node: bin }),
      ]);
      expect(e.result, e.stderr).toBeDefined();
      expect(c.result, c.stderr).toBeDefined();
      esm = e.result as FixtureResult;
      cjs = c.result as FixtureResult;
    });

    it.each(["redis", "redis5"])(
      "%s (6.0.0 / 5.11.1): commands, callback, error and pipeline are children of the caller",
      (scenario) => {
        const h = (body(esm, scenario) as unknown as { main: Tagged }).main;
        const kids = childrenOf(esm.spans, h.spanId).sort(
          (a, b) => a.startMs - b.startMs,
        );
        expect(kids.map((s) => s.name)).toEqual([
          "redis SET",
          "redis GET",
          "redis GET", // callback
          "redis SET",
          "redis LPUSH", // WRONGTYPE
          "redis GET", // pipeline: one span per command
          "redis INCR",
        ]);
        expect(kids[4]?.status.code).toBe(STATUS_ERROR);
        for (const s of kids) {
          expect(s.attributes["nestrix.ctx_keys"]).toBe(
            "args,command,database,serverAddress,serverPort",
          );
        }
        // ioredis redacts values itself: SET's value arrives as "?".
        expect(kids[0]?.attributes["nestrix.redis.args"]).toBe("nestrix:s2 ?");
      },
    );

    it.each(["redis", "redis5"])(
      "%s finding: a command queued before the connection is ready is traced on flush, outside the caller's context",
      (scenario) => {
        const offline = (body(esm, scenario) as unknown as { offline: string })
          .offline;
        expect(childrenOf(esm.spans, offline)).toHaveLength(0);
        const orphanGet = esm.spans.filter(
          (s) => s.name === "redis GET" && s.parentSpanId === undefined,
        );
        expect(orphanGet.length).toBeGreaterThanOrEqual(1);
      },
    );

    it("finding: connection handshake commands appear as root spans", () => {
      const roots = esm.spans
        .filter(
          (s) => s.name.startsWith("redis ") && s.parentSpanId === undefined,
        )
        .map((s) => s.name);
      expect(roots).toEqual(
        expect.arrayContaining(["redis INFO", "redis CLIENT"]),
      );
      expect(roots).toContain("redis HELLO"); // ioredis 6 only
    });

    it("CJS app: same parentage", () => {
      const h = body(cjs, "redis");
      expect(childrenOf(cjs.spans, h.spanId).map((s) => s.name)).toEqual([
        "redis SET",
        "redis GET",
      ]);
    });
  });
});
