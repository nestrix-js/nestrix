// /readyz against a real PostgreSQL (#32): database down and back, migrations, partitions.
// "Down" is a TCP proxy between the server's pool and the database that can stop, restart on
// the same port, or accept connections and answer nothing.
import { createServer as createHttpServer, type Server } from "node:http";
import net from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HealthService,
  healthMiddleware,
  READY_TIMEOUT_MS,
} from "../../src/health/health.js";
import { runMigrations } from "../../src/storage/migrate.js";
import { PartitionManager } from "../../src/storage/partitions.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";

class TcpProxy {
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();
  port = 0;
  mode: "forward" | "blackhole" = "forward";
  constructor(private readonly target: { host: string; port: number }) {}

  async start(): Promise<void> {
    const server = net.createServer((client) => {
      this.sockets.add(client);
      client.on("close", () => this.sockets.delete(client));
      client.on("error", () => undefined);
      if (this.mode === "blackhole") return; // accepted, never answered
      const upstream = net.connect(this.target.port, this.target.host);
      this.sockets.add(upstream);
      upstream.on("close", () => this.sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", resolve);
    });
    this.port = (server.address() as net.AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
  }
}

describe.skipIf(noDatabase)(`/readyz with PostgreSQL ${skipReason}`, () => {
  let db: TestDb;
  let proxy: TcpProxy;
  let pool: pg.Pool;
  let http: Server;
  let base: string;
  let health: HealthService;

  beforeAll(async () => {
    db = await createTestDb("readiness");
    await runMigrations(db.pool);
    const manager = new PartitionManager(db.pool, { retentionDays: 7 });
    await manager.start();
    manager.stop();

    const url = new URL(db.url);
    proxy = new TcpProxy({ host: url.hostname, port: Number(url.port) });
    await proxy.start();
    url.hostname = "127.0.0.1";
    url.port = String(proxy.port);
    pool = new pg.Pool({
      connectionString: url.href,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", () => undefined);

    // The partition manager of the server, as the readiness check sees it, sharing today's partitions.
    const seen = new PartitionManager(db.pool, { retentionDays: 7 });
    await seen.runOnce();
    health = new HealthService(pool, seen);
    http = createHttpServer((req, res) =>
      healthMiddleware(health)(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.address() as net.AddressInfo).port}`;
  });
  afterAll(async () => {
    http?.closeAllConnections();
    await new Promise<void>((resolve) => http?.close(() => resolve()));
    await proxy?.stop();
    await pool?.end().catch(() => undefined);
    await db?.drop();
  });

  const status = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { code: res.status, body: (await res.json()) as unknown };
  };

  it("is ready when the database, migrations and today's partitions are there", async () => {
    expect(await status("/readyz")).toEqual({
      code: 200,
      body: { status: "ok" },
    });
  });

  it("turns 503 when the database goes away and 200 when it returns; /livez stays 200", async () => {
    await proxy.stop();
    expect(await status("/readyz")).toEqual({
      code: 503,
      body: { status: "unavailable", reason: "database" },
    });
    expect((await status("/livez")).code).toBe(200);

    await proxy.start();
    expect(await status("/readyz")).toEqual({
      code: 200,
      body: { status: "ok" },
    });
  });

  it("gives up on a database that accepts and never answers, within the timeout", async () => {
    await proxy.stop();
    // Let the pool notice that its idle connection died, as it does within moments in service.
    await new Promise((resolve) => setTimeout(resolve, 100));
    proxy.mode = "blackhole";
    await proxy.start();
    try {
      const started = Date.now();
      const result = await status("/readyz");
      const took = Date.now() - started;
      expect(result).toEqual({
        code: 503,
        body: { status: "unavailable", reason: "database" },
      });
      expect(took).toBeGreaterThanOrEqual(READY_TIMEOUT_MS - 200);
      expect(took).toBeLessThan(READY_TIMEOUT_MS + 2_000);
      expect((await status("/livez")).code).toBe(200);
    } finally {
      await proxy.stop();
      proxy.mode = "forward";
      await proxy.start();
    }
    expect((await status("/readyz")).code).toBe(200);
  });

  it("shares one check between concurrent probes", async () => {
    let queries = 0;
    const counting = new HealthService(
      {
        query: (...args: unknown[]) => {
          queries++;
          return (pool.query as (...a: unknown[]) => unknown)(...args);
        },
      } as unknown as pg.Pool,
      undefined,
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => counting.readiness()),
    );
    expect(results.every((r) => r.ready)).toBe(true);
    expect(queries).toBe(2); // SELECT 1 and the migrations list, once
  });

  it("is 503 (migrations) while a migration is not recorded, then 200", async () => {
    const { rows } = await db.pool.query<{ name: string; checksum: string }>(
      "DELETE FROM nestrix_schema_migrations WHERE name = (SELECT max(name) FROM nestrix_schema_migrations) RETURNING name, checksum",
    );
    const removed = rows[0];
    expect(removed).toBeDefined();
    try {
      expect(await status("/readyz")).toEqual({
        code: 503,
        body: { status: "unavailable", reason: "migrations" },
      });
    } finally {
      await db.pool.query(
        "INSERT INTO nestrix_schema_migrations (name, checksum) VALUES ($1, $2)",
        [removed?.name, removed?.checksum],
      );
    }
    expect((await status("/readyz")).code).toBe(200);
  });

  it("is 503 (migrations) on a database that was never migrated", async () => {
    const fresh = await createTestDb("readiness_fresh");
    try {
      const probe = new HealthService(fresh.pool, undefined);
      expect(await probe.readiness()).toEqual({
        ready: false,
        reason: "migrations",
      });
    } finally {
      await fresh.drop();
    }
  });

  it("is 503 (partitions) when today has no partition", async () => {
    // A manager whose clock is a month ahead never listed a partition for that day (it is never run).
    const late = new PartitionManager(db.pool, {
      retentionDays: 7,
      now: () => Date.now() + 30 * 86_400_000,
    });
    const probe = new HealthService(pool, late);
    expect(await probe.readiness()).toEqual({
      ready: false,
      reason: "partitions",
    });
  });
});
