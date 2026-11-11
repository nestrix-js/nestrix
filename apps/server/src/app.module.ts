import { type DynamicModule, Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";
import { AuthModule } from "./auth/auth.module.js";
import { SessionQueryGuard } from "./auth/query-guard.js";
import type { ServerConfig } from "./config.js";
import { ServerConfigModule } from "./config.module.js";
import { IngestModule } from "./ingest/ingest.module.js";
import { MemoryIngestSink } from "./ingest/memory-sink.js";
import { INGEST_TRACES_PATH_PATTERN } from "./ingest/tokens.js";
import { QueryModule } from "./query/query.module.js";
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
          ignore: { routes: [INGEST_TRACES_PATH_PATTERN] },
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
              IngestModule.forRoot({
                sink: { useExisting: PostgresIngestSink },
              }),
              // Opened only for requests the admin login's middleware stamped as a session.
              QueryModule.forRoot({ guard: { useClass: SessionQueryGuard } }),
            ]),
      ],
    };
  }
}
