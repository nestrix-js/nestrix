import { type DynamicModule, Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";
import { AlertsModule } from "./alerts/alerts.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ReadQueryGuard } from "./auth/query-guard.js";
import { TokensModule } from "./auth/tokens.module.js";
import type { ServerConfig } from "./config.js";
import { ServerConfigModule } from "./config.module.js";
import { IngestModule } from "./ingest/ingest.module.js";
import { MemoryIngestSink } from "./ingest/memory-sink.js";
import { INGEST_PATH_PATTERN } from "./ingest/tokens.js";
import { RemoteProfilesModule } from "./profiler/remote-profiles.module.js";
import { QueryModule } from "./query/query.module.js";
import { SlosModule } from "./slos/slos.module.js";
import { PostgresIngestSink, StorageModule } from "./storage/index.js";
import { UiModule } from "./ui/ui.module.js";

export interface AppModuleOptions {
  /**
   * Tests of the receiver only: use the in-memory sink and leave out PostgreSQL and the query API
   * (they need a database). Never set by `createApp`.
   */
  inMemory?: boolean;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class AppModule {
  static forRoot(
    config: ServerConfig,
    options: AppModuleOptions = {},
  ): DynamicModule {
    // One object for both imports below, so Nest resolves a single IngestModule (one receiver,
    // one rate limiter, one memory budget) shared with remote profiling.
    const ingest = IngestModule.forRoot({
      sink: { useExisting: PostgresIngestSink },
    });
    return {
      module: AppModule,
      imports: [
        ServerConfigModule.forRoot(config),
        // Self-tracing: exports only when OTEL_EXPORTER_OTLP_ENDPOINT is set, never traces ingest.
        // Imported before modules that register global interceptors (architecture §4.2).
        NestrixModule.forRoot({
          // A default only: OTEL_SERVICE_NAME still names the service when set.
          serviceName:
            process.env.OTEL_SERVICE_NAME?.trim() || "nestrix-server",
          ui: false,
          // The server's own storage queries are not traced (a trace of each write would be
          // exported to the receiver, whose write would be traced again).
          integrations: { pg: false },
          ignore: { paths: [INGEST_PATH_PATTERN] },
        }),
        // Admin login (P5-04): its middleware is mounted by `configureApp`, its guard is global
        // and covers every controller, the query API included.
        AuthModule,
        UiModule,
        ...(options.inMemory
          ? [IngestModule.forRoot({ sink: { useClass: MemoryIngestSink } })]
          : [
              StorageModule.forRoot({
                databaseUrl: config.databaseUrl,
                retentionDays: config.retentionDays,
              }),
              ingest,
              // Remote CPU profiling (P10-02, D-76): instance check-in and upload on the ingest
              // key, the dashboard's instances and remote-profiles routes.
              RemoteProfilesModule.forRoot({ ingest }),
              // Opened only for requests the admin login's middleware stamped as a session, or as
              // a valid API token on a read route (P8-01).
              QueryModule.forRoot({ guard: { useClass: ReadQueryGuard } }),
              // API tokens (P8-01): `/api/v1/tokens` is admin-only; tokens only read the query API.
              TokensModule,
              // Alert rules, evaluator and webhooks (P7-03); `/api/v1/alerts` is admin-only.
              AlertsModule.forRoot(),
              // SLOs over the rollups (P7-04); `/api/v1/slos` is admin-only.
              SlosModule,
            ]),
      ],
    };
  }
}
