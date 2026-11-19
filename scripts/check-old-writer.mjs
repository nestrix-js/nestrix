#!/usr/bin/env node
/**
 * Migration policy check (D-109): the previous release's writers must still work on the schema the
 * current migrations produce, except where a migration is listed in
 * `apps/server/migrations/coordinated-stop.json` (a release that needs every replica stopped first).
 *
 * How:
 *  1. Finds the newest released `@nestrix-js/nestjs@X.Y.Z` tag (prereleases skipped) and extracts
 *     that tag's `apps/server/src` and `apps/server/migrations` with `git archive`.
 *  2. Statically extracts, from the old source, every `INSERT INTO <table> (<columns>)` and every
 *     `ON CONFLICT (<columns>)` target. A column list built with `${...}` cannot be read statically
 *     and is reported as unchecked.
 *  3. Migrates a scratch PostgreSQL database with the CURRENT migrations and checks each statement:
 *     the table and every column exist, every NOT NULL column without a default is in the list,
 *     and a valid, non-partial unique index whose columns equal the conflict target exists (that is
 *     what PostgreSQL needs to infer the arbiter).
 *  4. A break is allowed only when a migration newer than the old release's last one is listed in
 *     coordinated-stop.json, mentions the broken table, and has an upgrade note in a changeset (or,
 *     on the version PR, a package CHANGELOG.md) and in
 *     apps/server/README.md. Any other break exits 1.
 *
 * Not checked: UPDATE/DELETE statements, column types, and statements assembled at run time. The
 * checks are about the writes a replica of the previous release keeps making during a rolling update.
 *
 * Usage: node scripts/check-old-writer.mjs [--require-db]
 *   Database: NESTRIX_CHECK_DATABASE_URL (an admin URL, e.g. postgres://postgres@host/postgres; a
 *   scratch database is created and dropped), else a throwaway postgres:18-alpine container via
 *   Docker. With neither, exits 0 with a message, or 1 with --require-db (CI).
 */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireDb = process.argv.includes("--require-db");
const require = createRequire(join(root, "apps/server/package.json"));
const { default: pg } = await import(require.resolve("pg/lib/index.js")).then(
  (m) => m,
  () => ({ default: null }),
);

const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });

function fail(message) {
  console.error(`check-old-writer: ${message}`);
  process.exit(1);
}

// 1. The previous release.
const tags = git("tag", "--list", "@nestrix-js/nestjs@*", "--sort=-v:refname")
  .split("\n")
  .filter((t) => /^@nestrix-js\/nestjs@\d+\.\d+\.\d+$/.test(t));
if (tags.length === 0) {
  fail(
    "no released tag @nestrix-js/nestjs@X.Y.Z found (is the clone shallow? use fetch-depth: 0)",
  );
}
const tag = tags[0];
const work = mkdtempSync(join(tmpdir(), "old-writer-"));
execFileSync(
  "sh",
  [
    "-c",
    `git archive "$1" apps/server/src apps/server/migrations | tar -x -C "$2"`,
    "sh",
    tag,
    work,
  ],
  { cwd: root },
);
const oldMigrations = readdirSync(join(work, "apps/server/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const oldLast = oldMigrations.at(-1);
const currentDir = join(root, "apps/server/migrations");
const currentMigrations = readdirSync(currentDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const newer = currentMigrations.filter((f) => f > oldLast);
console.log(
  `previous release: ${tag} (last migration ${oldLast}); newer migrations: ${newer.join(", ") || "none"}`,
);

// 2. The old statements.
function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}
const idents = (list) =>
  list.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
const isIdentList = (list) =>
  idents(list).every((c) => /^[a-z_][a-z0-9_]*$/i.test(c));

const statements = [];
const unchecked = [];
for (const file of sourceFiles(join(work, "apps/server/src"))) {
  const text = readFileSync(file, "utf8");
  const where = (i) => `${relative(work, file)}:${lineOf(text, i)}`;
  const re =
    /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)(?:\s+AS\s+[a-z_][a-z0-9_]*)?\s*\(/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const table = m[1];
    if (table === "nestrix_schema_migrations") continue; // the migrator's own table
    const open = m.index + m[0].length - 1;
    const columns = balanced(text, open);
    // The statement ends at the template literal's closing backtick (or the string's quote).
    const rest = text.slice(open);
    const end = rest.search(/`|"\s*[,)+;]/);
    const body = end < 0 ? rest : rest.slice(0, end);
    if (columns === null || columns.includes("${") || !isIdentList(columns)) {
      unchecked.push(
        `${where(m.index)} INSERT INTO ${table} (dynamic column list)`,
      );
      continue;
    }
    const conflict = /ON\s+CONFLICT\s*\(([^)]*)\)/i.exec(body);
    let target = null;
    if (conflict) {
      if (isIdentList(conflict[1])) target = idents(conflict[1]);
      else
        unchecked.push(
          `${where(m.index)} ON CONFLICT (${conflict[1].trim()}) (not plain columns)`,
        );
    }
    statements.push({
      at: where(m.index),
      table,
      columns: idents(columns),
      target,
    });
  }
}
console.log(
  `old statements: ${statements.length} INSERT, ${statements.filter((s) => s.target).length} with an ON CONFLICT target; ${unchecked.length} not checkable statically`,
);
for (const u of unchecked) console.log(`  unchecked: ${u}`);

// 3. A database with the current migrations.
async function withDatabase(fn) {
  if (!pg) fail("the pg package is not installed (run pnpm install)");
  let adminUrl = process.env.NESTRIX_CHECK_DATABASE_URL ?? "";
  let container = null;
  if (!adminUrl) {
    try {
      await run("docker", ["version", "--format", "{{.Server.Version}}"], {
        timeout: 60_000,
      });
    } catch {
      const msg = "no database: set NESTRIX_CHECK_DATABASE_URL or start Docker";
      if (requireDb) fail(msg);
      console.log(`check-old-writer: skipped (${msg})`);
      process.exit(0);
    }
    const { stdout } = await run("docker", [
      "run",
      "--rm",
      "-d",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-p",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql",
      "postgres:18-alpine",
      "-c",
      "fsync=off",
    ]);
    container = stdout.trim();
    const port = (await run("docker", ["port", container, "5432/tcp"])).stdout
      .split("\n")[0]
      .split(":")
      .pop();
    adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const c = new pg.Client({ connectionString: adminUrl });
      try {
        await c.connect();
        await c.query("SELECT 1");
        await c.end();
        break;
      } catch (e) {
        await c.end().catch(() => {});
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  const name = `old_writer_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const client = new pg.Client({
    connectionString: adminUrl.replace(/\/[^/]*$/, `/${name}`),
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
    await admin
      .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      .catch(() => {});
    await admin.end().catch(() => {});
    if (container)
      await run("docker", ["stop", "--time", "2", container]).catch(() => {});
  }
}

const breaks = [];
await withDatabase(async (db) => {
  for (const f of currentMigrations) {
    try {
      await db.query(readFileSync(join(currentDir, f), "utf8"));
    } catch (e) {
      fail(`current migration ${f} failed: ${e.message}`);
    }
  }
  for (const s of statements) {
    const cols = await db.query(
      `SELECT a.attname, a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
      [s.table],
    );
    if (cols.rowCount === 0) {
      breaks.push({ ...s, why: `table ${s.table} does not exist` });
      continue;
    }
    const byName = new Map(cols.rows.map((r) => [r.attname, r]));
    for (const c of s.columns) {
      if (!byName.has(c))
        breaks.push({ ...s, why: `column ${s.table}.${c} does not exist` });
    }
    for (const r of cols.rows) {
      if (
        r.attnotnull &&
        !r.atthasdef &&
        !r.attgenerated &&
        !r.attidentity &&
        !s.columns.includes(r.attname)
      ) {
        breaks.push({
          ...s,
          why: `column ${s.table}.${r.attname} is NOT NULL without a default and the old INSERT omits it`,
        });
      }
    }
    if (s.target) {
      const idx = await db.query(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indrelid = to_regclass($1) AND i.indisunique AND i.indisvalid
            AND i.indpred IS NULL AND i.indexprs IS NULL
          GROUP BY i.indexrelid`,
        [s.table],
      );
      const want = [...s.target].sort().join(",");
      if (!idx.rows.some((r) => [...r.cols].sort().join(",") === want)) {
        breaks.push({
          ...s,
          why: `ON CONFLICT (${s.target.join(", ")}) has no matching unique index on ${s.table}`,
        });
      }
    }
  }
});

// 4. Compare with coordinated-stop.json.
const stopFile = join(currentDir, "coordinated-stop.json");
const stops = existsSync(stopFile)
  ? JSON.parse(readFileSync(stopFile, "utf8"))
  : {};
const problems = [];
const changesets = existsSync(join(root, ".changeset"))
  ? readdirSync(join(root, ".changeset"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(root, ".changeset", f), "utf8"))
      .join("\n")
  : "";
// The version PR (`changeset version`) moves changeset text into each package's CHANGELOG.md and
// deletes the changeset files, so a note there counts too.
const changelogs = readdirSync(join(root, "packages"))
  .map((d) => join(root, "packages", d, "CHANGELOG.md"))
  .filter((f) => existsSync(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const serverReadme = readFileSync(join(root, "apps/server/README.md"), "utf8");
const activeStops = [];
for (const [name, reason] of Object.entries(stops)) {
  if (!currentMigrations.includes(name)) {
    problems.push(
      `coordinated-stop.json lists ${name}, which is not a migration`,
    );
    continue;
  }
  if (typeof reason !== "string" || reason.trim() === "")
    problems.push(`coordinated-stop.json: ${name} has no reason`);
  if (name <= oldLast) continue; // already released: history, nothing to enforce
  const number = name.slice(0, 4);
  if (!changesets.includes(number) && !changelogs.includes(number))
    problems.push(
      `${name} is a coordinated stop but no changeset or package CHANGELOG mentions ${number}`,
    );
  if (!serverReadme.includes(number))
    problems.push(
      `${name} is a coordinated stop but apps/server/README.md has no upgrade note mentioning ${number}`,
    );
  activeStops.push(name);
}
const allowedBy = (b) =>
  activeStops.find((name) =>
    new RegExp(`\\b${b.table}\\b`).test(
      readFileSync(join(currentDir, name), "utf8"),
    ),
  );

let unlisted = 0;
for (const b of breaks) {
  const by = allowedBy(b);
  if (by) {
    console.log(`allowed by coordinated stop: ${by}\n  ${b.at}: ${b.why}`);
  } else {
    unlisted++;
    console.log(`BREAK ${b.at}: ${b.why}\n  columns: ${b.columns.join(", ")}`);
  }
}
for (const p of problems) console.log(`PROBLEM ${p}`);
rmSync(work, { recursive: true, force: true });

if (unlisted > 0 || problems.length > 0) {
  console.log(
    `\n${unlisted} unlisted break(s), ${problems.length} problem(s). A migration may only add or relax; remove or re-key in the release after next (expand/contract), or list it in apps/server/migrations/coordinated-stop.json with an upgrade note (D-109).`,
  );
  process.exit(1);
}
console.log(
  `ok: ${statements.length} old statements checked, ${breaks.length} allowed by a coordinated stop, 0 unlisted breaks`,
);
