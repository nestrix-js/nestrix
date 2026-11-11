import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { enablePg, instrumentPgExports } from "../src/nestrix/pg.js";
import {
  childrenOf,
  dbs,
  type FixtureResult,
  nodeBinaries,
  requireBuilt,
  runFixture,
  runNode,
  SPAN_KIND_CLIENT,
  STATUS_ERROR,
  skipNote,
  spikeRoot,
} from "./helpers.js";

requireBuilt();

describe("Q5 pg wrapper: mechanics without a database", () => {
  function fakePg(clientQuery: (...a: unknown[]) => unknown) {
    class Client {
      query(...a: unknown[]) {
        return clientQuery(...a);
      }
    }
    class Pool {
      query(..._a: unknown[]) {
        return Promise.resolve("pool");
      }
    }
    return { Client, Pool } as unknown as Parameters<
      typeof instrumentPgExports
    >[0];
  }

  it("a synchronous throw from pg reaches the caller once, and pg is called once", () => {
    let calls = 0;
    const pg = fakePg(() => {
      calls++;
      throw new TypeError("Client was passed a null or undefined query");
    });
    instrumentPgExports(pg, "fake");
    const client = new (
      pg.Client as unknown as new () => { query: (q: unknown) => unknown }
    )();
    expect(() => client.query(null)).toThrow(TypeError);
    expect(calls).toBe(1);
    expect(() => client.query("SELECT 1")).toThrow(TypeError);
    expect(calls).toBe(2);
  });

  it("keeps name and length, and wrapping twice is a no-op", () => {
    const pg = fakePg(() => Promise.resolve(1));
    const proto = pg.Client.prototype as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const before = proto.query as (...a: unknown[]) => unknown;
    expect(instrumentPgExports(pg, "fake")).toBe(true);
    const wrapped = proto.query as (...a: unknown[]) => unknown;
    expect(wrapped).not.toBe(before);
    expect([wrapped.name, wrapped.length]).toEqual([
      before.name,
      before.length,
    ]);
    expect(instrumentPgExports(pg, "fake")).toBe(false);
    expect(proto.query).toBe(wrapped);
  });

  it("pg absent from the resolution path: integration reports MODULE_NOT_FOUND and does nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nestrix-s2-nopg-"));
    const from = join(dir, "index.js");
    writeFileSync(from, "");
    const out = await runNode<{ result: unknown }>(
      join(spikeRoot, "scripts/resolve-from.mjs"),
      {
        marker: "__RESOLVE__",
        args: [from],
      },
    );
    expect(out.result?.result).toEqual({
      enabled: false,
      reason: "MODULE_NOT_FOUND",
    });
  });

  it("finding: NODE_PATH from a pnpm bin shim makes a hoisted pg resolvable from anywhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nestrix-s2-nopg-"));
    const from = join(dir, "index.js");
    writeFileSync(from, "");
    const out = await runNode<{ result: { enabled: boolean } }>(
      join(spikeRoot, "scripts/resolve-from.mjs"),
      {
        marker: "__RESOLVE__",
        args: [from],
        env: {
          NODE_PATH: join(spikeRoot, "../../node_modules/.pnpm/node_modules"),
        },
      },
    );
    expect(out.result?.result.enabled).toBe(true);
  });

  it("in-process sanity: enablePg resolves from this package", () => {
    expect(
      enablePg({ from: pathToFileURL(join(spikeRoot, "package.json")).href })
        .enabled,
    ).toBe(true);
  });
});

interface Tagged {
  spanId: string;
  result: Record<string, unknown>;
}

describe.skipIf(!dbs.pg)(
  skipNote("Q5 pg in the fixture apps", !!dbs.pg),
  () => {
    describe.each(nodeBinaries())("Node $label", ({ bin }) => {
      let esm: FixtureResult;
      let cjs: FixtureResult;
      beforeAll(async () => {
        const [e, c] = await Promise.all([
          runFixture("esm", ["pg", "pg-contention"], { node: bin }),
          runFixture("cjs", ["pg"], { node: bin }),
        ]);
        expect(e.result, e.stderr).toBeDefined();
        expect(c.result, c.stderr).toBeDefined();
        esm = e.result as FixtureResult;
        cjs = c.result as FixtureResult;
      });

      it("createRequire from the stand-in resolves the same pg file the app imports", () => {
        for (const r of [esm, cjs]) {
          expect(r.enable.pg.enabled).toBe(true);
          expect(r.enable.pg.resolvedFrom).toMatch(
            /pg@8\.23\.1\/node_modules\/pg\/lib\/index\.js$/,
          );
        }
      });

      it("ESM app: client promise/callback, pool promise/callback, error, cursor and stream each give one child span", () => {
        const h = esm.responses.pg?.body as Tagged;
        expect(h.result).toMatchObject({
          clientPromise: [{ n: 1 }],
          clientCallback: [{ n: 2 }],
          poolPromise: [{ n: 3 }],
          poolCallback: [{ n: 4 }],
          cursor: [{ n: 1 }, { n: 2 }],
          stream: [{ n: 1 }, { n: 2 }, { n: 3 }],
        });
        const kids = childrenOf(esm.spans, h.spanId).sort(
          (a, b) => a.startMs - b.startMs,
        );
        expect(kids.map((s) => s.attributes["nestrix.pg.via"])).toEqual([
          "client",
          "client",
          "pool",
          "pool",
          "client",
          "client",
          "client",
        ]);
        for (const s of kids) expect(s.kind).toBe(SPAN_KIND_CLIENT);
        expect(kids[4]?.status.code).toBe(STATUS_ERROR);
        expect(kids[5]?.attributes["nestrix.pg.submittable"]).toBe(true);
      });

      it("pool contention: the queued query is parented to its own caller, one span per pool.query", () => {
        const c = esm.responses["pg-contention"]?.body as {
          a: string;
          b: string;
        };
        expect(childrenOf(esm.spans, c.a)).toHaveLength(1);
        expect(childrenOf(esm.spans, c.b)).toHaveLength(1);
      });

      it("CJS app (require('pg')): same", () => {
        const h = cjs.responses.pg?.body as Tagged;
        expect(
          childrenOf(cjs.spans, h.spanId)
            .map((s) => s.attributes["nestrix.pg.via"])
            .sort(),
        ).toEqual(["client", "client", "pool"]);
      });
    });

    it("F3: concurrent pool.query calls sharing one config object (named prepared statement): one pool span each, nothing extra", async () => {
      const out = await runNode<{
        shared: Record<string, string[]>;
        residual: Record<string, string[]>;
      }>(join(spikeRoot, "scripts/pg-shared.mjs"), {
        marker: "__PG_SHARED__",
        env: { PG_URL: dbs.pg },
      });
      expect(out.result, out.stderr).toBeDefined();
      expect(out.result?.shared).toEqual({
        A: ["pool"],
        B: ["pool"],
        C: ["pool"],
      });
    });

    it("F3 residual: a direct client.query(sameConfig) while a pool.query with that config is queued is skipped, and the pool's inner query is traced in the wrong context", async () => {
      const out = await runNode<{
        residual: Record<string, string[]>;
        pgSpans: number;
      }>(join(spikeRoot, "scripts/pg-shared.mjs"), {
        marker: "__PG_SHARED__",
        env: { PG_URL: dbs.pg },
      });
      const r = out.result?.residual;
      expect(r?.F).toEqual([]); // the direct query got no span
      expect(r?.E).toEqual(["pool"]);
      // E's inner client.query found no token and became a client span under D, the
      // handler whose query created the pooled connection (socket context).
      expect(r?.D).toEqual(["pool", "client"]);
      expect(out.result?.pgSpans).toBe(6);
    });

    it("finding: wrapping both prototypes naively double-counts pool.query and misparents under contention", async () => {
      const r = (
        await runFixture("esm", ["pg-contention"], {
          env: { NESTRIX_PG_DEDUPE: "0" },
        })
      ).result as FixtureResult;
      const c = r.responses["pg-contention"]?.body as { a: string; b: string };
      const underA = childrenOf(r.spans, c.a)
        .map((s) => s.attributes["nestrix.pg.via"])
        .sort();
      const underB = childrenOf(r.spans, c.b).map(
        (s) => s.attributes["nestrix.pg.via"],
      );
      // A gets its own pool+client spans plus B's inner client span; B keeps only its pool span.
      expect(underA).toEqual(["client", "client", "pool"]);
      expect(underB).toEqual(["pool"]);
    });
  },
);

interface OrmResult {
  node: string;
  execArgv: string[];
  format: string;
  report: {
    enabled: boolean;
    resolvedFrom?: string;
    version?: string;
    reason?: string;
  };
  loadedPgCopies: Array<{ file: string; version: string }>;
  byRun: Record<string, { pgSpans: number; modules: string[]; via: string[] }>;
  errors: Record<string, string>;
}

const fixturesReady = ["strict", "nopg", "nopg-nohoist"].every((ws) =>
  existsSync(
    join(
      spikeRoot,
      "fixtures",
      ws,
      "app",
      "generated-js",
      "prisma",
      "client.js",
    ),
  ),
);
const ormNote = !fixturesReady
  ? " [SKIPPED: fixtures not installed; run `pnpm --filter spike-p0-s2 fixtures:install`]"
  : !dbs.pg
    ? " [SKIPPED: Postgres not reachable; run `pnpm --filter spike-p0-s2 db:up`]"
    : "";

function runOrm(ws: string, file: string, env: Record<string, string> = {}) {
  return runNode<OrmResult>(join(spikeRoot, "fixtures", ws, "app", file), {
    marker: "__ORM_RESULT__",
    cwd: join(spikeRoot, "fixtures", ws, "app"),
    env: { PG_URL: dbs.pg, ...env },
  });
}

describe.skipIf(!fixturesReady || !dbs.pg)(
  `Q5/Q6 ORMs and Prisma under pnpm's strict layout${ormNote}`,
  () => {
    describe.each(["orm.mjs", "orm.cjs"])("strict workspace, %s", (file) => {
      let r: OrmResult;
      beforeAll(async () => {
        const out = await runOrm("strict", file, { SCAN: "1" });
        expect(out.result, out.stderr + out.stdout).toBeDefined();
        r = out.result as OrmResult;
        expect(r.errors).toEqual({});
        expect(r.execArgv).toEqual([]);
      });

      it("the optional peer resolves to the app's pg (8.23.1)", () => {
        expect(r.report.enabled).toBe(true);
        expect(r.report.version).toBe("8.23.1");
      });

      it("raw pg, TypeORM, Drizzle and Prisma (adapter-pg) queries pass through the wrapped methods", () => {
        for (const name of ["raw", "typeorm", "drizzle", "prisma"]) {
          expect(r.byRun[name]?.pgSpans, name).toBeGreaterThanOrEqual(1);
          expect(r.byRun[name]?.modules, name).toEqual(["pg@8.23.1"]);
        }
        expect(r.byRun.prisma?.via.every((v) => v === "pool")).toBe(true);
      });

      it("nested copy: MikroORM's own pg (8.20.0 via override) is a second module instance and is not traced", () => {
        expect(r.loadedPgCopies.map((c) => c.version).sort()).toEqual([
          "8.20.0",
          "8.23.1",
        ]);
        expect(r.byRun.mikro?.pgSpans).toBe(0);
      });

      it("candidate fix: wrapping every pg in the module cache reaches the nested copy", () => {
        expect(r.byRun["mikro+scan"]).toEqual({
          pgSpans: 1,
          modules: ["pg@8.20.0"],
          via: ["client"],
          ...(file === "orm.mjs" ? { statements: ["SELECT ? AS n"] } : {}),
        });
        expect(r.byRun["raw+scan"]?.pgSpans).toBe(1); // no double wrapping
      });
    });

    describe.each(["nopg", "nopg-nohoist"])(
      "%s workspace: the app never lists pg (it comes from @prisma/adapter-pg)",
      (ws) => {
        it.each(["orm.mjs", "orm.cjs"])(
          "%s: pnpm links the optional peer anyway; Prisma is traced",
          async (file) => {
            const out = await runOrm(ws, file, { ORMS: "prisma" });
            const r = out.result as OrmResult;
            expect(r, out.stderr).toBeDefined();
            expect(r.errors).toEqual({});
            expect(r.report.resolvedFrom).toMatch(
              new RegExp(`fixtures/${ws}/node_modules/\\.pnpm/pg@8\\.23\\.1/`),
            );
            expect(r.byRun.prisma?.modules).toEqual(["pg@8.23.1"]);
          },
        );
      },
    );

    it("node versions: the strict ESM and CJS probes (all ORMs, Prisma, cache scan) give the same answer on every available Node", async () => {
      for (const { bin } of nodeBinaries()) {
        for (const file of ["orm.mjs", "orm.cjs"]) {
          const out = await runNode<OrmResult>(
            join(spikeRoot, "fixtures/strict/app", file),
            {
              marker: "__ORM_RESULT__",
              node: bin,
              cwd: join(spikeRoot, "fixtures/strict/app"),
              env: { PG_URL: dbs.pg, SCAN: "1" },
            },
          );
          const r = out.result as OrmResult;
          const at = `${file} ${r?.node}`;
          expect(r, out.stderr).toBeDefined();
          expect(r.errors, at).toEqual({});
          for (const name of ["raw", "typeorm", "drizzle", "prisma"]) {
            expect(r.byRun[name]?.modules, `${at} ${name}`).toEqual([
              "pg@8.23.1",
            ]);
          }
          expect(r.byRun.mikro?.pgSpans, at).toBe(0);
          expect(r.byRun["mikro+scan"]?.modules, at).toEqual(["pg@8.20.0"]);
        }
      }
    });
  },
);
