import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      enabled: true,
      serviceName: "my-api",
      resourceAttributes: { "deployment.environment.name": "production" },
      sampleRate: 0.25,
      export: {
        otlp: {
          endpoint: "http://otel-collector:4318",
          headers: { authorization: "Bearer my-token" },
          timeoutMillis: 10_000,
        },
        queue: {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5000,
        },
      },
      ignore: {
        paths: ["/health", /^\/metrics/],
        outgoing: ["https://o123.ingest.sentry.io/"],
      },
      http: {
        requestHeaders: ["x-correlation-id"],
        responseHeaders: ["cache-control"],
        redactQueryKeys: ["ticket"],
      },
      redact: () => undefined,
    }),
  ],
})
export class AppModule {}
