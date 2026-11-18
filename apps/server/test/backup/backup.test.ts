/**
 * The backup procedure of docs-site/guide/production.md, run for real (issues #35): a database
 * filled through the real ingest path (POST /v1/traces and /v1/logs), dumped with
 * `pg_dump --format=custom` WHILE ingest keeps running, restored with `pg_restore` into a fresh
 * database, and read back by a second server started on the restored database.
 *
 * pg_dump and pg_restore run inside the test PostgreSQL container (`docker exec`), so their
 * version always matches the server's: no `postgresql-client` is needed on the host, and a CI
 * runner's older client cannot refuse the dump. Without Docker the file skips, like every
 * storage test (and fails under CI).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, JSON_TYPE, post } from "../ingest/helpers.js";
import { type QueryServer, startQueryServer } from "../query/helpers.js";
import {
  adminUrl,
  createTestDb,
  hex,
  noDatabase,
  nsAt,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";

const run = promisify(execFile);

async function inContainer(
  container: string,
  ...command: string[]
): Promise<string> {
  const { stdout } = await run("docker", ["exec", container, ...command], {
    timeout: 120_000,
  });
  return stdout;
}

/** The container that publishes the test database's port (the one global-setup started). */
async function containerOf(url: string): Promise<string> {
  const port = new URL(url).port;
  const { stdout } = await run("docker", [
    "ps",
    "-q",
    "--filter",
    `publish=${port}`,
  ]);
  const id = stdout.trim().split("\n")[0];
  if (!id) throw new Error(`no container publishes port ${port}`);
  return id;
}

function tracePayload(traceId: string, rootSpanId: string, startMs: number) {
  const span = (
    spanId: string,
    name: string,
    kind: number,
    offsetMs: number,
    parent?: string,
  ) => ({
    traceId,
    spanId,
    ...(parent ? { parentSpanId: parent } : {}),
    name,
    kind,
    startTimeUnixNano: String(nsAt(startMs + offsetMs)),
    endTimeUnixNano: String(nsAt(startMs + offsetMs + 4)),
    attributes:
      kind === 2
        ? [
            { key: "http.request.method", value: { stringValue: "GET" } },
            { key: "http.route", value: { stringValue: "/orders/:id" } },
            { key: "http.response.status_code", value: { intValue: "200" } },
          ]
        : [{ key: "db.system.name", value: { stringValue: "postgresql" } }],
    status: { code: 0 },
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "orders" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "backup-test" },
            spans: [
              span(rootSpanId, "GET /orders/:id", 2, 0),
              span(hex(8), "SELECT orders", 3, 1, rootSpanId),
              span(hex(8), "SELECT customers", 3, 2, rootSpanId),
            ],
          },
        ],
      },
    ],
  };
}

function logPayload(traceId: string, spanId: string, startMs: number) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "orders" } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(nsAt(startMs + 1)),
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: `order loaded ${traceId}` },
                traceId,
                spanId,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe.skipIf(noDatabase)(`backup and restore ${skipReason}`, () => {
  let source: TestDb;
  let restored: TestDb | undefined;
  let sourceServer: QueryServer;
  let restoredServer: QueryServer | undefined;
  let container = "";
  const dumpFile = `/tmp/nestrix-backup-${hex(4)}.dump`;
  let restoredName = "";

  const known: string[] = []; // ingested and acknowledged before the dump started
  let stopIngest = false;
  let background: Promise<number> | undefined;

  async function ingestTrace(): Promise<string> {
    const traceId = hex(16);
    const rootSpanId = hex(8);
    const start = Date.now() - 5_000;
    const headers = { ...auth(), "content-type": JSON_TYPE };
    const spans = await post(
      `${sourceServer.baseUrl}/v1/traces`,
      JSON.stringify(tracePayload(traceId, rootSpanId, start)),
      headers,
    );
    const logs = await post(
      `${sourceServer.baseUrl}/v1/logs`,
      JSON.stringify(logPayload(traceId, rootSpanId, start)),
      headers,
    );
    expect([spans.status, logs.status]).toEqual([200, 200]);
    return traceId;
  }

  beforeAll(async () => {
    container = await containerOf(adminUrl);
    source = await createTestDb("backup_src");
    sourceServer = await startQueryServer(source.url);
    for (let i = 0; i < 25; i++) known.push(await ingestTrace());

    // Keep ingesting while the dump runs: it must still be one consistent snapshot.
    background = (async () => {
      let count = 0;
      while (!stopIngest) {
        await ingestTrace();
        count++;
      }
      return count;
    })();
  });

  afterAll(async () => {
    stopIngest = true;
    await background?.catch(() => undefined);
    await restoredServer?.close();
    await sourceServer?.close();
    await inContainer(container, "rm", "-f", dumpFile).catch(() => undefined);
    await restored?.drop();
    await source?.drop();
  });

  it("pg_dump during ingest, pg_restore into a fresh database, then a trace and its logs read back", async () => {
    const sourceName = new URL(source.url).pathname.slice(1);
    await inContainer(
      container,
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "-U",
      "postgres",
      "-d",
      sourceName,
      "-f",
      dumpFile,
    );
    stopIngest = true;
    const ingestedWhileDumping = await background;
    expect(ingestedWhileDumping).toBeGreaterThan(0);

    restoredName = `backup_dst_${hex(4)}`;
    await inContainer(container, "createdb", "-U", "postgres", restoredName);
    await inContainer(
      container,
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      "-U",
      "postgres",
      "-d",
      restoredName,
      dumpFile,
    );
    const restoredUrl = adminUrl.replace(/\/postgres$/, `/${restoredName}`);
    const pool = new pg.Pool({ connectionString: restoredUrl, max: 2 });
    restored = {
      url: restoredUrl,
      pool,
      async drop() {
        await pool.end().catch(() => undefined);
        const admin = new pg.Client({ connectionString: adminUrl });
        await admin.connect();
        await admin.query(
          `DROP DATABASE IF EXISTS ${restoredName} WITH (FORCE)`,
        );
        await admin.end();
      },
    };

    // One snapshot: no span without its trace row, and every trace row's span_count matches the
    // spans stored for it, although ingest was writing the whole time.
    const orphans = await pool.query(
      `SELECT count(*)::int AS n FROM spans s
        WHERE NOT EXISTS (SELECT 1 FROM traces t WHERE t.trace_id = s.trace_id)`,
    );
    expect(orphans.rows[0].n).toBe(0);
    const mismatched = await pool.query(
      `SELECT count(*)::int AS n FROM traces t
        WHERE t.span_count <> (SELECT count(*) FROM spans s WHERE s.trace_id = t.trace_id)`,
    );
    expect(mismatched.rows[0].n).toBe(0);

    // The migrations are recorded in the dump, so the restored database needs none.
    const sourceMigrations = await source.pool.query(
      "SELECT name, checksum FROM nestrix_schema_migrations ORDER BY name",
    );
    const restoredMigrations = await pool.query(
      "SELECT name, checksum FROM nestrix_schema_migrations ORDER BY name",
    );
    expect(restoredMigrations.rows).toEqual(sourceMigrations.rows);
    expect(restoredMigrations.rows.length).toBeGreaterThan(0);

    // The query side, started on the restored database, reads what was acknowledged before the dump.
    restoredServer = await startQueryServer(restoredUrl);
    for (const traceId of [known[0], known[known.length - 1]] as string[]) {
      const original = await sourceServer.json<{ spans: unknown[] }>(
        `/api/v1/trace?id=${traceId}`,
      );
      const copy = await restoredServer.json<{ spans: unknown[] }>(
        `/api/v1/trace?id=${traceId}`,
      );
      expect(copy.spans).toHaveLength(3);
      expect(copy).toEqual(original);

      const logs = await restoredServer.json<{ items: { message: string }[] }>(
        `/api/v1/trace/logs?id=${traceId}`,
      );
      expect(logs.items.map((l) => l.message)).toEqual([
        `order loaded ${traceId}`,
      ]);
    }
    const count = await pool.query("SELECT count(*)::int AS n FROM traces");
    expect(count.rows[0].n).toBeGreaterThanOrEqual(known.length);
  });
});
