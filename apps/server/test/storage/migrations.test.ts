import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  runMigrations,
} from "../../src/storage/migrate.js";
import {
  dayLabel,
  ensurePartitions,
  utcDay,
} from "../../src/storage/partitions.js";
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
    const all = [
      "0001_init.sql",
      "0002_alerts.sql",
      "0003_slos.sql",
      "0004_alert_checks.sql",
      "0005_traces_has_job.sql",
      "0006_api_tokens.sql",
      "0007_logs.sql",
      "0008_remote_profiles.sql",
      "0009_spans_parent_idx.sql",
      "0010_traces_dropped_spans.sql",
      "0011_instance_runtime.sql",
      "0012_traces_has_errors.sql",
      "0013_traces_has_errors_index.sql",
      "0014_admin_sessions.sql",
      "0016_environments.sql",
      "0017_traces_attributes.sql",
      "0018_error_triage.sql",
      "0019_dashboard_users.sql",
      "0020_metric_minutes.sql",
      "0021_logs_search.sql",
      "0022_logs_search_indexes.sql",
    ];
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
      PgSmallInt: "int2",
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

describe.skipIf(noDatabase)(
  `logs index pre-build (README upgrade note) ${skipReason}`,
  () => {
    let db: TestDb;
    beforeAll(async () => {
      db = await createTestDb("migratelogs");
    });
    afterAll(async () => {
      await db?.drop();
    });

    it("0022 finds indexes built per partition, outside a transaction, and builds none of its own", async () => {
      const dir = await mkdtemp(join(tmpdir(), "nestrix-migrations-"));
      await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
      await rm(join(dir, "0022_logs_search_indexes.sql"));
      expect((await runMigrations(db.pool, dir)).applied.at(-1)).toBe(
        "0021_logs_search.sql",
      );
      const day = utcDay(Date.now());
      await ensurePartitions(db.pool, [day]);
      const part = `logs_p${dayLabel(day)}`;
      // The README's statements, one by one (CONCURRENTLY cannot run in a transaction).
      const defs: Array<[string, string, string]> = [
        ["time", "(time_ns DESC, trace_id DESC, record_hash DESC)", ""],
        [
          "service_time",
          "(service_name, time_ns DESC, trace_id DESC, record_hash DESC)",
          "",
        ],
        [
          "errors_time",
          "(time_ns DESC, trace_id DESC, record_hash DESC)",
          " WHERE severity_number >= 17",
        ],
        ["body_fts", "(to_tsvector('simple', body))", ""],
      ];
      for (const [name, cols, where] of defs) {
        const using = name === "body_fts" ? " USING gin" : "";
        await db.pool.query(
          `CREATE INDEX CONCURRENTLY ${part}_${name}_idx ON ${part}${using} ${cols}${where}`,
        );
        await db.pool.query(
          `CREATE INDEX logs_${name}_idx ON ONLY logs${using} ${cols}${where}`,
        );
        await db.pool.query(
          `ALTER INDEX logs_${name}_idx ATTACH PARTITION ${part}_${name}_idx`,
        );
      }
      const before = await db.pool.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY 1",
        [part],
      );
      expect((await runMigrations(db.pool, dir)).applied).toEqual([]);
      // The real directory now has 0022; it applies on top without adding a second index.
      const res = await runMigrations(db.pool);
      expect(res.applied).toEqual(["0022_logs_search_indexes.sql"]);
      const after = await db.pool.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY 1",
        [part],
      );
      expect(after.rows).toEqual(before.rows);
      const { rows } = await db.pool.query(
        `SELECT c.relname, i.indisvalid, EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = c.oid) AS attached
           FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname LIKE '${part}\\_%\\_idx'`,
      );
      expect(
        rows.filter(
          (r) =>
            r.relname.includes("_time_idx") ||
            r.relname.includes("_fts_idx") ||
            r.relname.includes("_errors_time_idx"),
        ),
      ).not.toHaveLength(0);
      for (const r of rows.filter((r) =>
        /_(time|service_time|errors_time|body_fts)_idx$/.test(r.relname),
      )) {
        expect(r.indisvalid, r.relname).toBe(true);
        expect(r.attached, r.relname).toBe(true);
      }
    });
  },
);
