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
      "0023_spans_ingest_seq.sql",
      "0024_spans_ingest_seq_index.sql",
      "0025_metric_minutes_unit.sql",
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
      // And the later files, so the run stops at 0021 as the upgrade note's install would.
      await rm(join(dir, "0023_spans_ingest_seq.sql"));
      await rm(join(dir, "0024_spans_ingest_seq_index.sql"));
      await rm(join(dir, "0025_metric_minutes_unit.sql"));
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
      expect(res.applied).toEqual([
        "0022_logs_search_indexes.sql",
        "0023_spans_ingest_seq.sql",
        "0024_spans_ingest_seq_index.sql",
        "0025_metric_minutes_unit.sql",
      ]);
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

describe.skipIf(noDatabase)(
  `spans ingest_seq pre-build (README upgrade note, D-114) ${skipReason}`,
  () => {
    let db: TestDb;
    beforeAll(async () => {
      db = await createTestDb("migrateseq");
    });
    afterAll(async () => {
      await db?.drop();
    });

    it("0023 and 0024 find the column and the indexes built per partition, and build nothing", async () => {
      const dir = await mkdtemp(join(tmpdir(), "nestrix-migrations-"));
      await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
      await rm(join(dir, "0023_spans_ingest_seq.sql"));
      await rm(join(dir, "0024_spans_ingest_seq_index.sql"));
      await rm(join(dir, "0025_metric_minutes_unit.sql"));
      expect((await runMigrations(db.pool, dir)).applied.at(-1)).toBe(
        "0022_logs_search_indexes.sql",
      );
      const now = Date.now();
      const days = [utcDay(now - 86_400_000), utcDay(now)];
      await ensurePartitions(db.pool, days);
      const parts = days.map((d) => `spans_p${dayLabel(d)}`);
      // The README's statements, one by one (CONCURRENTLY cannot run in a transaction).
      await db.pool.query(
        "CREATE SEQUENCE IF NOT EXISTS spans_ingest_seq AS bigint CACHE 1",
      );
      await db.pool.query(
        "ALTER TABLE spans ADD COLUMN IF NOT EXISTS ingest_seq bigint",
      );
      await db.pool.query(
        "ALTER TABLE spans ALTER COLUMN ingest_seq SET DEFAULT nextval('spans_ingest_seq')",
      );
      for (const part of parts) {
        await db.pool.query(
          `CREATE INDEX CONCURRENTLY ${part}_errors_ingest_seq_idx ON ${part} (ingest_seq) WHERE is_error`,
        );
      }
      await db.pool.query(
        "CREATE INDEX spans_errors_ingest_seq_idx ON ONLY spans (ingest_seq) WHERE is_error",
      );
      for (const part of parts) {
        await db.pool.query(
          `ALTER INDEX spans_errors_ingest_seq_idx ATTACH PARTITION ${part}_errors_ingest_seq_idx`,
        );
      }
      const indexes = async () =>
        (
          await db.pool.query<{ indexname: string }>(
            "SELECT indexname FROM pg_indexes WHERE tablename = ANY($1) AND indexname LIKE '%ingest_seq%' ORDER BY 1",
            [[...parts, "spans"]],
          )
        ).rows.map((r) => r.indexname);
      const before = await indexes();
      const res = await runMigrations(db.pool);
      expect(res.applied).toEqual([
        "0023_spans_ingest_seq.sql",
        "0024_spans_ingest_seq_index.sql",
        "0025_metric_minutes_unit.sql",
      ]);
      expect(await indexes()).toEqual(before);
      const parent = await db.pool.query<{ indisvalid: boolean }>(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'spans_errors_ingest_seq_idx'`,
      );
      expect(parent.rows[0]?.indisvalid).toBe(true);
      // A partition created later inherits the index and the default.
      const later = utcDay(now + 86_400_000);
      await ensurePartitions(db.pool, [later]);
      const inherited = await db.pool.query<{ n: string; def: string }>(
        `SELECT (SELECT count(*) FROM pg_indexes WHERE tablename = $1 AND indexname LIKE '%ingest_seq%')::text AS n,
                (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
                   JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                  WHERE d.adrelid = $1::regclass AND a.attname = 'ingest_seq') AS def`,
        [`spans_p${dayLabel(later)}`],
      );
      expect(inherited.rows[0]).toEqual({
        n: "1",
        def: "nextval('spans_ingest_seq'::regclass)",
      });
    });

    it("0023 rewrites no partition: existing rows keep their storage and get NULL", async () => {
      const db2 = await createTestDb("migrateseqrw");
      try {
        const dir = await mkdtemp(join(tmpdir(), "nestrix-migrations-"));
        await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
        await rm(join(dir, "0023_spans_ingest_seq.sql"));
        await rm(join(dir, "0024_spans_ingest_seq_index.sql"));
        await rm(join(dir, "0025_metric_minutes_unit.sql"));
        await runMigrations(db2.pool, dir);
        const day = utcDay(Date.now());
        await ensurePartitions(db2.pool, [day]);
        const part = `spans_p${dayLabel(day)}`;
        await db2.pool.query(
          "INSERT INTO resources (hash, service_name, attributes) VALUES ('h', 'shop', '{}')",
        );
        await db2.pool.query(
          `INSERT INTO spans (trace_id, span_id, resource_id, service_name, name, kind, start_time,
                              start_ns, end_ns, duration_ns, status_code, attributes, events, links,
                              is_root, is_error, trace_type)
           SELECT md5(g::text), substr(md5(g::text), 1, 16), (SELECT id FROM resources), 'shop',
                  'x', 'internal', now(), 0, 0, 0, 'error', '{}', '[]', '[]', true, true, 'other'
             FROM generate_series(1, 2000) g`,
        );
        const node = async () =>
          (
            await db2.pool.query<{ f: string }>(
              "SELECT relfilenode::text AS f FROM pg_class WHERE relname = $1",
              [part],
            )
          ).rows[0]?.f;
        const before = await node();
        await runMigrations(db2.pool);
        expect(await node()).toBe(before);
        const n = await db2.pool.query<{ nulls: string }>(
          "SELECT count(*) FILTER (WHERE ingest_seq IS NULL)::text AS nulls FROM spans",
        );
        expect(n.rows[0]?.nulls).toBe("2000");
      } finally {
        await db2.drop();
      }
    });
  },
);
