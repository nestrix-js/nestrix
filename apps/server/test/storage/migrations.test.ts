import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  runMigrations,
} from "../../src/storage/migrate.js";
import { schema } from "../../src/storage/schema.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "./helpers.js";

describe.skipIf(noDatabase)(`migrations ${skipReason}`, () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb("migrate");
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("applies every file once; a second run (and a concurrent one) applies nothing", async () => {
    const [a, b] = await Promise.all([
      runMigrations(db.pool),
      runMigrations(db.pool),
    ]);
    // The advisory lock serialises the two runs: one applies, the other finds it done.
    const all = ["0001_init.sql", "0002_alerts.sql", "0003_slos.sql"];
    const applied = [...a.applied, ...b.applied];
    expect(applied).toEqual(all);
    expect([...a.skipped, ...b.skipped]).toEqual(all);

    const again = await runMigrations(db.pool);
    expect(again).toEqual({ applied: [], skipped: all });

    const { rows } = await db.pool.query(
      "SELECT name FROM nestrix_schema_migrations ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual(all);
  });

  it("refuses to start when an applied migration was edited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nestrix-migrations-"));
    await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    const file = join(dir, "0001_init.sql");
    await writeFile(file, `${await readFile(file, "utf8")}\n-- edited\n`);
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(
      /0001_init\.sql was changed after it was applied/,
    );
  });

  it("rolls back a failing migration and leaves it unrecorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nestrix-migrations-"));
    await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    await writeFile(
      join(dir, "0002_broken.sql"),
      "CREATE TABLE half_done (id int);\nSELECT no_such_function();\n",
    );
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(
      /migration 0002_broken\.sql failed/,
    );
    const { rows } = await db.pool.query(
      "SELECT to_regclass('half_done') AS t, (SELECT count(*) FROM nestrix_schema_migrations WHERE name = '0002_broken.sql')::int AS n",
    );
    expect(rows[0]).toEqual({ t: null, n: 0 });
  });

  it("the Drizzle schema matches the tables the SQL creates (columns, types, nullability)", async () => {
    const { rows } = await db.pool.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: "YES" | "NO";
    }>(
      `SELECT table_name, column_name, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1)`,
      [Object.values(schema).map((t) => getTableConfig(t).name)],
    );
    const actual = new Map(
      rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
    );
    const pgType: Record<string, string> = {
      PgText: "text",
      PgBigInt53: "int8",
      PgBigInt64: "int8",
      PgInteger: "int4",
      PgBoolean: "bool",
      PgDoublePrecision: "float8",
      PgJsonb: "jsonb",
      PgTimestamp: "timestamptz",
    };
    const expected = new Set<string>();
    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const key = `${config.name}.${column.name}`;
        expected.add(key);
        const row = actual.get(key);
        expect(row, key).toBeDefined();
        const columnType = column.columnType;
        const isArray = columnType === "PgArray";
        const base = isArray
          ? (column as unknown as { baseColumn: { columnType: string } })
              .baseColumn.columnType
          : columnType;
        expect(row?.udt_name, key).toBe(
          `${isArray ? "_" : ""}${pgType[base] ?? base}`,
        );
        expect(row?.is_nullable === "NO", `${key} not null`).toBe(
          column.notNull,
        );
      }
    }
    expect([...actual.keys()].filter((k) => !expected.has(k))).toEqual([]);
  });
});
