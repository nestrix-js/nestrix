/**
 * Old writer, new schema (security audit, "Rolling upgrades break 0.6.0 ingest").
 *
 * Migration 0016 (D-101) replaces the primary keys of `route_minutes` and `class_minutes` with
 * unique indexes that include `environment`. The 0.6.0 server's upserts name the old columns in
 * `ON CONFLICT (...)`; PostgreSQL cannot infer an arbiter index for them any more, so a 0.6.0
 * replica still taking traffic after the migration fails its whole ingest transaction.
 *
 * A key that works for both writers is impossible (a unique index on the old columns would forbid
 * the same route in two environments), so this release REQUIRES stopping every server replica
 * before the new version starts (changeset feat-28-environments, apps/server/README.md and
 * docs-site/guide/production.md, D-101 and D-109). THE COORDINATED-STOP REQUIREMENT DEPENDS ON
 * THIS TEST: if the failure assertions below ever start passing, rolling upgrades may have become
 * possible and the docs can be relaxed; if the "still works" assertions fail, another statement
 * of the 0.6.0 writer broke and must be added to the upgrade notes.
 *
 * The general policy (D-109, expand/contract) is enforced by `scripts/check-old-writer.mjs`, which
 * extracts the previous release's real SQL from its git tag and allows only the migrations listed
 * in `apps/server/migrations/coordinated-stop.json` (0016 is listed). This file stays as the
 * precise regression test of this one release.
 */
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  runMigrations,
} from "../../src/storage/migrate.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "./helpers.js";

// Verbatim from `git show @nestrix-js/ui@0.6.0:apps/server/src/storage/writer.ts` (the rollup
// upserts of the 0.6.0 server, lines ~746 and ~775).
const OLD_ROUTE_UPSERT = `INSERT INTO route_minutes AS r
           (minute, service_name, method, route, count, errors, total_ms, max_ms, hist)
         SELECT u.minute, u.service_name, u.method, u.route, u.count, u.errors, u.total_ms,
                u.max_ms, u.hist::int[]
           FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::int[],
                       $6::int[], $7::float8[], $8::float8[], $9::text[])
                AS u(minute, service_name, method, route, count, errors, total_ms, max_ms, hist)
         ON CONFLICT (minute, service_name, method, route) DO UPDATE SET
           count = r.count + EXCLUDED.count,
           errors = r.errors + EXCLUDED.errors,
           total_ms = r.total_ms + EXCLUDED.total_ms,
           max_ms = greatest(r.max_ms, EXCLUDED.max_ms),
           hist = nestrix_hist_add(r.hist, EXCLUDED.hist)`;

const OLD_CLASS_UPSERT = `INSERT INTO class_minutes AS c
           (minute, service_name, class_name, method_name, class_kind, count, errors, total_ms,
            max_ms, hist)
         SELECT u.minute, u.service_name, u.class_name, u.method_name, u.class_kind, u.count,
                u.errors, u.total_ms, u.max_ms, u.hist::int[]
           FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[],
                       $6::int[], $7::int[], $8::float8[], $9::float8[], $10::text[])
                AS u(minute, service_name, class_name, method_name, class_kind, count, errors,
                     total_ms, max_ms, hist)
         ON CONFLICT (minute, service_name, class_name, method_name) DO UPDATE SET
           class_kind = EXCLUDED.class_kind,
           count = c.count + EXCLUDED.count,
           errors = c.errors + EXCLUDED.errors,
           total_ms = c.total_ms + EXCLUDED.total_ms,
           max_ms = greatest(c.max_ms, EXCLUDED.max_ms),
           hist = nestrix_hist_add(c.hist, EXCLUDED.hist)`;

// The other conflict targets of the 0.6.0 server (grep "ON CONFLICT (" in its src/), checked to
// still be inferable on the new schema. Run against zero rows: arbiter inference happens at
// planning, so a missing unique index fails even when nothing is inserted.
const OTHER_OLD_TARGETS: Array<[table: string, columns: string]> = [
  ["services", "name"],
  ["resources", "hash"],
  ["traces", "trace_id, partition_time"],
  ["alert_state", "rule_id"],
  ["instances", "service, instance_id"],
  ["admin_session_revocations", "nonce"],
  ["admin_login_failures", "id"],
  ["admin_login_clients", "client"],
];

const MINUTE = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
const day = MINUTE.slice(0, 10);
const HIST = `{${Array.from({ length: 16 }, () => 0).join(",")}}`;

function routeArgs(route: string): unknown[] {
  return [[MINUTE], ["api"], ["GET"], [route], [1], [0], [5], [5], [HIST]];
}
function classArgs(method: string): unknown[] {
  return [
    [MINUTE],
    ["api"],
    ["UsersService"],
    [method],
    ["provider"],
    [1],
    [0],
    [5],
    [5],
    [HIST],
  ];
}

const NO_ARBITER = /no unique or exclusion constraint matching the ON CONFLICT/;

describe.skipIf(noDatabase)(
  `old writer on the new schema ${skipReason}`,
  () => {
    let db: TestDb;
    let preDir: string;
    beforeAll(async () => {
      db = await createTestDb("oldwriter");
      // The 0.6.0 schema: every migration before 0016 (0.6.0 shipped 0001 to 0014).
      preDir = await mkdtemp(join(tmpdir(), "nestrix-old-schema-"));
      for (const f of await readdir(DEFAULT_MIGRATIONS_DIR)) {
        if (f < "0016") {
          await cp(join(DEFAULT_MIGRATIONS_DIR, f), join(preDir, f));
        }
      }
      await runMigrations(db.pool, preDir);
      // ensurePartitions needs the 0020 table, so the old schema gets its two partitions by hand.
      // The day is the one of MINUTE; the new-schema run below finds them and adds the rest.
      for (const t of ["route_minutes", "class_minutes"]) {
        await db.pool.query(
          `CREATE TABLE ${t}_p_today PARTITION OF ${t}
           FOR VALUES FROM ('${day}T00:00:00Z') TO ('${day}T00:00:00Z'::timestamptz + interval '1 day')`,
        );
      }
    });
    afterAll(async () => {
      await db?.drop();
      if (preDir) await rm(preDir, { recursive: true, force: true });
    });

    it("before 0016 the 0.6.0 statements work (control)", async () => {
      await db.pool.query(OLD_ROUTE_UPSERT, routeArgs("/control"));
      await db.pool.query(OLD_ROUTE_UPSERT, routeArgs("/control"));
      await db.pool.query(OLD_CLASS_UPSERT, classArgs("control"));
      const { rows } = await db.pool.query(
        "SELECT count FROM route_minutes WHERE route = '/control'",
      );
      expect(rows).toEqual([{ count: 2 }]);
    });

    it("after 0016 to 0022 the 0.6.0 rollup upserts fail, and only those", async () => {
      await runMigrations(db.pool);

      await expect(
        db.pool.query(OLD_ROUTE_UPSERT, routeArgs("/old")),
      ).rejects.toThrow(NO_ARBITER);
      await expect(
        db.pool.query(OLD_CLASS_UPSERT, classArgs("old")),
      ).rejects.toThrow(NO_ARBITER);

      // Every other conflict target of the 0.6.0 writer still has its arbiter index.
      for (const [table, columns] of OTHER_OLD_TARGETS) {
        await db.pool.query(
          `INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM ${table} WHERE false ON CONFLICT (${columns}) DO NOTHING`,
        );
      }
    });

    it("the new targets work, and keep the same route apart per environment", async () => {
      const insert = (env: string | null) =>
        db.pool.query(
          `INSERT INTO route_minutes AS r
           (minute, service_name, environment, method, route, count, errors, total_ms, max_ms, hist)
         VALUES ($1, 'api', $2, 'GET', '/new', 1, 0, 5, 5, $3::int[])
         ON CONFLICT (minute, service_name, environment, method, route) DO UPDATE SET
           count = r.count + EXCLUDED.count`,
          [MINUTE, env, HIST],
        );
      await insert("prod");
      await insert("prod");
      await insert(null);
      await insert(null);
      await insert("staging");
      const { rows } = await db.pool.query(
        "SELECT environment, count FROM route_minutes WHERE route = '/new' ORDER BY environment NULLS LAST",
      );
      expect(rows).toEqual([
        { environment: "prod", count: 2 },
        { environment: "staging", count: 1 },
        { environment: null, count: 2 },
      ]);

      await db.pool.query(
        `INSERT INTO class_minutes AS c
         (minute, service_name, environment, class_name, method_name, class_kind, count, errors,
          total_ms, max_ms, hist)
       VALUES ($1, 'api', NULL, 'UsersService', 'new', 'provider', 1, 0, 5, 5, $2::int[])
       ON CONFLICT (minute, service_name, environment, class_name, method_name) DO UPDATE SET
         count = c.count + EXCLUDED.count`,
        [MINUTE, HIST],
      );
    });
  },
);
