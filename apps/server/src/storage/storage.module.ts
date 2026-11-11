/**
 * Nest wiring of the storage: the pg `Pool`, the Drizzle handle, migrations and partitions at
 * start, the ingest writer, and an orderly shutdown.
 *
 * ```ts
 * // app.module.ts: replaces the in-memory sink provider
 * imports: [StorageModule.forRoot({ sinkToken: INGEST_SINK })]
 * ```
 *
 * `forRoot` is global, so the query API can inject `STORAGE_DB` (Drizzle, `StorageDb`) and
 * `STORAGE_POOL` (pg `Pool`) anywhere. Start-up fails with a clear error when the database is
 * unreachable, a migration fails, or an applied migration was edited.
 */
import {
  type DynamicModule,
  Inject,
  type InjectionToken,
  Logger,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { runMigrations } from "./migrate.js";
import { PartitionManager } from "./partitions.js";
import { type StorageSchema, schema } from "./schema.js";
import { PostgresIngestSink, type WriterOptions } from "./writer.js";

export const STORAGE_POOL = Symbol.for("nestrix.storage.pool");
export const STORAGE_DB = Symbol.for("nestrix.storage.db");
export const STORAGE_PARTITIONS = Symbol.for("nestrix.storage.partitions");
const STORAGE_OPTIONS = Symbol.for("nestrix.storage.options");

export type StorageDb = NodePgDatabase<StorageSchema>;

export interface StorageOptions {
  /** Default: `DATABASE_URL`. */
  databaseUrl?: string;
  /** Days kept before today. Default: `NESTRIX_RETENTION_DAYS`, else 7. */
  retentionDays?: number;
  /** Also provide the writer under this token (the receiver's `IngestSink` token). */
  sinkToken?: InjectionToken;
  /** Pool size. Default 10. */
  poolMax?: number;
  writer?: WriterOptions;
  /** Partition maintenance interval. Default one hour. */
  maintenanceIntervalMs?: number;
  /** Migrations directory. Default `apps/server/migrations`. */
  migrationsDir?: string;
}

interface ResolvedStorageOptions {
  databaseUrl: string;
  retentionDays: number;
  poolMax: number;
  writer: WriterOptions;
  maintenanceIntervalMs: number;
  migrationsDir?: string;
}

export function resolveStorageOptions(
  options: StorageOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedStorageOptions {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("storage: DATABASE_URL is not set");
  }
  const rawRetention = options.retentionDays ?? env.NESTRIX_RETENTION_DAYS ?? 7;
  const retentionDays = Number(rawRetention);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  ) {
    throw new Error(
      `storage: NESTRIX_RETENTION_DAYS must be a whole number of days from 1 to 3650 (got ${JSON.stringify(rawRetention)})`,
    );
  }
  const resolved: ResolvedStorageOptions = {
    databaseUrl,
    retentionDays,
    poolMax: options.poolMax ?? 10,
    writer: options.writer ?? {},
    maintenanceIntervalMs: options.maintenanceIntervalMs ?? 3_600_000,
  };
  if (options.migrationsDir !== undefined)
    resolved.migrationsDir = options.migrationsDir;
  return resolved;
}

class StorageLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(STORAGE_POOL) private readonly pool: pg.Pool,
    @Inject(STORAGE_PARTITIONS) private readonly partitions: PartitionManager,
    @Inject(PostgresIngestSink) private readonly sink: PostgresIngestSink,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.partitions.stop();
    await this.sink.close(10_000);
    await this.pool.end();
  }
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class StorageModule {
  static forRoot(options: StorageOptions = {}): DynamicModule {
    const logger = new Logger("NestrixStorage");
    const providers: Provider[] = [
      {
        provide: STORAGE_OPTIONS,
        useFactory: () => resolveStorageOptions(options),
      },
      {
        provide: STORAGE_POOL,
        inject: [STORAGE_OPTIONS],
        useFactory: (o: ResolvedStorageOptions) => {
          const pool = new pg.Pool({
            connectionString: o.databaseUrl,
            max: o.poolMax,
            connectionTimeoutMillis: 10_000,
            application_name: "nestrix-server",
          });
          // An idle client's error is emitted on the pool; unhandled, it would crash the process.
          pool.on("error", (error) =>
            logger.warn(`idle database connection failed: ${error.message}`),
          );
          return pool;
        },
      },
      {
        provide: STORAGE_PARTITIONS,
        inject: [STORAGE_POOL, STORAGE_OPTIONS],
        useFactory: async (pool: pg.Pool, o: ResolvedStorageOptions) => {
          const migrations = await runMigrations(pool, o.migrationsDir);
          if (migrations.applied.length > 0) {
            logger.log(`applied migrations: ${migrations.applied.join(", ")}`);
          }
          const partitions = new PartitionManager(pool, {
            retentionDays: o.retentionDays,
            intervalMs: o.maintenanceIntervalMs,
            onError: (error) =>
              logger.warn(
                `partition maintenance failed (retried next run): ${(error as Error).message}`,
              ),
            onRun: ({ created, dropped }) => {
              if (created.length > 0)
                logger.log(`created partitions: ${created.join(", ")}`);
              if (dropped.length > 0)
                logger.log(
                  `dropped partitions (retention): ${dropped.join(", ")}`,
                );
            },
          });
          await partitions.start();
          return partitions;
        },
      },
      {
        provide: PostgresIngestSink,
        inject: [STORAGE_POOL, STORAGE_PARTITIONS, STORAGE_OPTIONS],
        useFactory: (
          pool: pg.Pool,
          partitions: PartitionManager,
          o: ResolvedStorageOptions,
        ) =>
          new PostgresIngestSink(pool, partitions, {
            ...o.writer,
            onError: (error, context) => {
              o.writer.onError?.(error, context);
              logger.warn(
                `${context}: ${(error as Error)?.message ?? String(error)}`,
              );
            },
          }),
      },
      {
        provide: STORAGE_DB,
        inject: [STORAGE_POOL],
        useFactory: (pool: pg.Pool): StorageDb =>
          drizzle({ client: pool, schema }),
      },
      StorageLifecycle,
    ];
    const exported: InjectionToken[] = [
      STORAGE_POOL,
      STORAGE_DB,
      STORAGE_PARTITIONS,
      PostgresIngestSink,
    ];
    if (options.sinkToken !== undefined) {
      providers.push({
        provide: options.sinkToken,
        useExisting: PostgresIngestSink,
      });
      exported.push(options.sinkToken);
    }
    return {
      module: StorageModule,
      global: true,
      providers,
      exports: exported,
    };
  }
}
