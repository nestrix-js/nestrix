import { type DynamicModule, Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";
import { AuthModule } from "./auth/auth.module.js";
import type { ServerConfig } from "./config.js";
import { ServerConfigModule } from "./config.module.js";
import { IngestModule } from "./ingest/ingest.module.js";
import { MemoryIngestSink } from "./ingest/memory-sink.js";
import { INGEST_TRACES_PATH_PATTERN } from "./ingest/tokens.js";
import { UiModule } from "./ui/ui.module.js";

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class AppModule {
  static forRoot(config: ServerConfig): DynamicModule {
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
          ignore: { routes: [INGEST_TRACES_PATH_PATTERN] },
        }),
        // The sink: P5-02 replaces this line with its Postgres writer, e.g.
        // IngestModule.forRoot({ imports: [StorageModule], sink: { useExisting: PostgresIngestSink } }),
        IngestModule.forRoot({ sink: { useClass: MemoryIngestSink } }),
        // Admin login (P5-04): its middleware is mounted by `configureApp`, its guard is global
        // and covers every controller, the query API included.
        AuthModule,
        UiModule,
      ],
    };
  }
}
