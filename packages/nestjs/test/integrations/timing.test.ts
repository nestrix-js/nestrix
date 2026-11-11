// D-50 timing check (backlog P3-01 item 1): is a nested `pg` copy already in the module cache when
// the integration enables (NestrixCore's constructor) and at onApplicationBootstrap, in a real
// Nest app, ESM and CJS? A temporary directory holds a separate copy of `pg` (with its dependency
// closure, copied from the workspace's) and two stand-in ORMs that load it, as MikroORM loads its
// pinned `pg`: one CommonJS (`require('pg')`) and one ESM (`import pg from 'pg'`). Each fixture
// app is a plain `node` child process (no flags, NODE_OPTIONS and NODE_PATH removed) that loads
// Nestrix from this package's `dist` (built in beforeAll), and runs GET /q twice, each one query
// through the nested copy against the real PostgreSQL. The results are printed for the report.
import { execFile, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { address, skipReason, tcpOpen, waitUntil } from "./helpers.js";

const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgDir = join(here, "../..");
const require = createRequire(import.meta.url);
const reason = skipReason("postgres");

/** The directory of package `name` as Node would find it from `fromDir` (no exports map needed). */
function findPackageDir(name: string, fromDir: string): string | undefined {
  let dir = realpathSync(fromDir);
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json")))
        return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Copies `name` and its dependency closure, flattened, into `dest` (a node_modules dir). */
function copyClosure(
  name: string,
  fromDir: string,
  dest: string,
  seen: Set<string>,
): void {
  if (seen.has(name)) return;
  const dir = findPackageDir(name, fromDir);
  if (dir === undefined) return; // an optional dependency that is not installed
  seen.add(name);
  cpSync(dir, join(dest, name), {
    recursive: true,
    dereference: true,
    filter: (src) => !src.slice(dir.length).includes("node_modules"),
  });
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    copyClosure(dep, dir, dest, seen);
  }
}

interface Result {
  nestedPath: string;
  nestedWrapped: boolean;
  status: {
    enabled: boolean;
    resolved?: string;
    modules: { path: string; phase: "enable" | "bootstrap" }[];
  };
  bodies: unknown[];
  dbSpans: { name: string; underServerSpan: boolean }[];
}

type Mode = "eager" | "factory" | "late-factory" | "async-factory" | "request";
const CASES = (["mjs", "cjs"] as const).flatMap((app) =>
  (["cjs", "esm"] as const).flatMap((orm) =>
    (
      ["eager", "factory", "late-factory", "async-factory", "request"] as const
    ).map((mode) => ({ app, orm, mode })),
  ),
);

describe.skipIf(reason !== undefined)(
  "D-50: nested pg copies and scan timing in a Nest app",
  () => {
    let root: string;
    const results = new Map<string, Result>();

    beforeAll(async () => {
      // Nestrix from `dist`, current with `src` (incremental; a no-op when already built).
      const tsc = createRequire(join(pkgDir, "../../package.json")).resolve(
        "typescript/bin/tsc",
      );
      execFileSync(process.execPath, [tsc, "-b"], {
        cwd: pkgDir,
        stdio: "inherit",
      });

      root = mkdtempSync(join(tmpdir(), "nestrix-nested-pg-"));
      const nodeModules = join(root, "node_modules");
      mkdirSync(nodeModules, { recursive: true });
      copyClosure("pg", pkgDir, nodeModules, new Set());
      const cjsOrm = join(nodeModules, "fake-orm-cjs");
      mkdirSync(cjsOrm);
      writeFileSync(
        join(cjsOrm, "package.json"),
        JSON.stringify({ name: "fake-orm-cjs", main: "index.js" }),
      );
      writeFileSync(
        join(cjsOrm, "index.js"),
        `"use strict";
const pg = require("pg");
module.exports = { pg, pgPath: require.resolve("pg"), createPool: (c) => new pg.Pool(c) };
`,
      );
      const esmOrm = join(nodeModules, "fake-orm-esm");
      mkdirSync(esmOrm);
      writeFileSync(
        join(esmOrm, "package.json"),
        JSON.stringify({
          name: "fake-orm-esm",
          type: "module",
          exports: "./index.js",
        }),
      );
      writeFileSync(
        join(esmOrm, "index.js"),
        `import { createRequire } from "node:module";
import pg from "pg";
export { pg };
export const pgPath = createRequire(import.meta.url).resolve("pg");
export function createPool(c) { return new pg.Pool(c); }
`,
      );

      await waitUntil(() => tcpOpen(address("postgres")), 30_000, "postgres");
      const env: Record<string, string | undefined> = {
        ...process.env,
        PG_HOST: address("postgres").host,
        PG_PORT: String(address("postgres").port),
      };
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      await Promise.all(
        CASES.map(async ({ app, orm, mode }) => {
          const ormEntry = join(nodeModules, `fake-orm-${orm}`, "index.js");
          const { stdout } = await run(
            process.execPath,
            [join(here, `fixtures/timing-app.${app}`), ormEntry, mode],
            { env, timeout: 30_000 },
          );
          const line = stdout.trim().split("\n").pop() ?? "";
          results.set(`${app}/${orm}/${mode}`, JSON.parse(line) as Result);
        }),
      );
      const table = CASES.map(({ app, orm, mode }) => {
        const r = results.get(`${app}/${orm}/${mode}`);
        const nested = r?.status.modules.find(
          (m) => m.path === realpathSync(r.nestedPath),
        );
        return `  app ${app.padEnd(3)} orm ${orm.padEnd(3)} ${mode.padEnd(13)} nested copy: ${(nested?.phase ?? "not wrapped").padEnd(11)} db spans under the server span: ${r?.dbSpans.filter((s) => s.underServerSpan).length}/2`;
      });
      console.log(`[D-50 timing]\n${table.join("\n")}`);
    }, 90_000);

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it("the nested copy is a separate file from the pg this package resolves", () => {
      const r = results.get("mjs/cjs/eager");
      expect(r?.status.resolved).toBe(require.resolve("pg"));
      expect(realpathSync(r?.nestedPath ?? "")).not.toBe(r?.status.resolved);
      expect(realpathSync(r?.nestedPath ?? "")).toMatch(
        /nestrix-nested-pg-.*[\\/]node_modules[\\/]pg[\\/]lib[\\/]index\.js$/,
      );
    });

    for (const { app, orm, mode } of CASES) {
      const key = `${app}/${orm}/${mode}`;
      const expected: Record<Mode, "enable" | "bootstrap" | undefined> = {
        // Measured: Nest builds every module's providers concurrently (`Promise.all` in
        // @nestjs/core 12.4.2 injector/instance-loader.js `createInstances`), so construction order
        // follows how many microtask turns each provider's dependencies take, not module order.
        // NestrixCore waits for NESTRIX_OPTIONS and HttpAdapterHost, so a dependency-free factory
        // has run before its constructor wherever its module is; a factory that awaits real work
        // first runs after it and is caught by the onApplicationBootstrap scan.
        eager: "enable",
        factory: "enable",
        "late-factory": "enable",
        "async-factory": "bootstrap",
        request: undefined,
      };
      it(`${key}: nested copy ${expected[mode] === undefined ? "missed (loaded after the last scan)" : `wrapped at ${expected[mode]}`}`, () => {
        const r = results.get(key) as Result;
        expect(r.bodies).toEqual([{ n: 1 }, { n: 1 }]);
        const nested = r.status.modules.find(
          (m) => m.path === realpathSync(r.nestedPath),
        );
        expect(nested?.phase).toBe(expected[mode]);
        expect(r.nestedWrapped).toBe(expected[mode] !== undefined);
        if (expected[mode] === undefined) {
          expect(r.dbSpans).toEqual([]);
        } else {
          expect(r.dbSpans).toEqual([
            { name: "SELECT", underServerSpan: true },
            { name: "SELECT", underServerSpan: true },
          ]);
        }
      });
    }
  },
);
