/**
 * Applies `apps/server/migrations/*.sql` at start, in file-name order, each once.
 *
 * - Serialised across server instances by a session-level advisory lock held on one
 *   dedicated connection for the whole run (a second instance waits, then finds nothing to do).
 * - Each file runs in its own transaction together with the row that records it, so a failed
 *   file leaves nothing behind and is retried on the next start.
 * - The SHA-256 of each applied file is recorded; an applied file whose content has changed
 *   stops the start with an error naming it (migrations are append-only).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { ADVISORY_CLASS, MIGRATION_LOCK } from "./locks.js";

/** `apps/server/migrations`, from `src/storage` and from `dist/storage` alike. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

const MIGRATIONS_TABLE = "nestrix_schema_migrations";

export interface MigrationResult {
  /** Files applied by this run, in order. */
  applied: string[];
  /** Files that were already applied. */
  skipped: string[];
}

export async function runMigrations(
  pool: Pool,
  directory: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const files = (await readdir(directory))
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const sources = await Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );

  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      ADVISORY_CLASS,
      MIGRATION_LOCK,
    ]);
    locked = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${MIGRATIONS_TABLE}`,
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    const result: MigrationResult = { applied: [], skipped: [] };
    for (const m of sources) {
      const recorded = done.get(m.name);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) {
          throw new Error(
            `migration ${m.name} was changed after it was applied (checksum ${recorded.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…); add a new migration instead`,
          );
        }
        result.skipped.push(m.name);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`,
          [m.name, m.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(
          `migration ${m.name} failed: ${(error as Error).message}`,
          { cause: error },
        );
      }
      result.applied.push(m.name);
    }
    return result;
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock($1, $2)", [
          ADVISORY_CLASS,
          MIGRATION_LOCK,
        ])
        .catch(() => undefined);
    }
    client.release();
  }
}
