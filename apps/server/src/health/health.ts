/**
 * Issue #32 (D-95): the server's own health, for Docker, Swarm, Kubernetes and load balancers.
 *
 * - `GET /livez`: 200 while the process serves HTTP.
 * - `GET /readyz`: 200 when `SELECT 1` succeeds within `READY_TIMEOUT_MS`, every migration file is
 *   recorded as applied, and a partition exists for today in every table; otherwise 503 with a
 *   fixed reason (`database`, `migrations`, `partitions`), and 503 (`shutting-down`) once shutdown
 *   begins. The answer holds no data and no error text.
 *
 * Answered by a middleware mounted by `configureApp` before the admin login, so no credential is
 * asked for, nothing is redirected to `/login`, and neither the login limiter nor the ingest
 * limiter sees the request. The paths are in the self-tracing `ignore` list (`app.module.ts`).
 * Never throws.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import type { Pool } from "pg";
import { pathnameOf, writeRaw } from "../auth/http.js";
import { migrationFileNames } from "../storage/migrate.js";
import type { PartitionManager } from "../storage/partitions.js";
import { STORAGE_PARTITIONS, STORAGE_POOL } from "../storage/storage.module.js";

/** The health paths: exact, one optional trailing slash, any case (as Express routes them). */
export const HEALTH_PATH_PATTERN = /^\/(?:livez|readyz)\/?$/i;
const READY_PATH = /^\/readyz\/?$/i;

/** Longest a readiness check waits for the database. Shorter than the image's probe timeout (3 s). */
export const READY_TIMEOUT_MS = 2_000;

export type NotReadyReason =
  | "database"
  | "migrations"
  | "partitions"
  | "shutting-down";
export type Readiness =
  | { ready: true }
  | { ready: false; reason: NotReadyReason };

const MIGRATIONS_TABLE = "nestrix_schema_migrations";
const UNDEFINED_TABLE = "42P01";

class ProbeTimeout extends Error {}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout("timeout")), ms);
  });
  // The losing promise may reject later; that must not become an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger("Health");
  private shuttingDown = false;
  private inflight: Promise<Readiness> | undefined;
  private lastReady = true;
  private expectedMigrations: string[] | undefined;

  constructor(
    @Optional() @Inject(STORAGE_POOL) private readonly pool?: Pool,
    @Optional()
    @Inject(STORAGE_PARTITIONS)
    private readonly partitions?: PartitionManager,
  ) {}

  /** The first Nest hook of `app.close()`: from here `/readyz` answers 503. */
  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  /** Concurrent probes share one check, so probing cannot load the database. */
  readiness(): Promise<Readiness> {
    if (this.shuttingDown) {
      return Promise.resolve({ ready: false, reason: "shutting-down" });
    }
    this.inflight ??= this.check()
      .catch((): Readiness => ({ ready: false, reason: "database" }))
      .then((result) => {
        this.report(result);
        return result;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private report(result: Readiness): void {
    if (result.ready === this.lastReady) return;
    this.lastReady = result.ready;
    try {
      if (result.ready) this.logger.log("ready again");
      else this.logger.warn(`not ready: ${result.reason}`);
    } catch {
      // Logging must not change the answer.
    }
  }

  private async check(): Promise<Readiness> {
    const pool = this.pool;
    if (pool === undefined) return { ready: true };
    try {
      await within(pool.query("SELECT 1"), READY_TIMEOUT_MS);
      this.expectedMigrations ??= await migrationFileNames();
      const expected = this.expectedMigrations;
      const { rows } = await within(
        pool.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`),
        READY_TIMEOUT_MS,
      );
      const applied = new Set(rows.map((r) => r.name));
      if (expected.some((name) => !applied.has(name))) {
        return { ready: false, reason: "migrations" };
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        ready: false,
        reason: code === UNDEFINED_TABLE ? "migrations" : "database",
      };
    }
    const partitions = this.partitions;
    if (partitions !== undefined && !partitions.hasDay(partitions.today())) {
      return { ready: false, reason: "partitions" };
    }
    return { ready: true };
  }
}

type Next = (error?: unknown) => void;

function send(res: ServerResponse, status: number, body: object): void {
  writeRaw(res, {
    status,
    csp: "default-src 'none'",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

/** The `app.use()` middleware: answers the two health paths, passes everything else on. */
export function healthMiddleware(
  health: HealthService,
): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  return (req, res, next) => {
    let path = "";
    try {
      path = pathnameOf(req);
    } catch {
      path = "";
    }
    if (!HEALTH_PATH_PATTERN.test(path)) {
      next();
      return;
    }
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeRaw(res, {
          status: 405,
          csp: "default-src 'none'",
          headers: { allow: "GET, HEAD" },
        });
        return;
      }
      if (!READY_PATH.test(path)) {
        send(res, 200, { status: "ok" });
        return;
      }
      health.readiness().then(
        (result) =>
          result.ready
            ? send(res, 200, { status: "ok" })
            : send(res, 503, { status: "unavailable", reason: result.reason }),
        () => send(res, 503, { status: "unavailable", reason: "database" }),
      );
    } catch {
      send(res, 503, { status: "unavailable", reason: "database" });
    }
  };
}
