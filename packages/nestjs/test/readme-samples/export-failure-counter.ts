import { Module } from "@nestjs/common";
import { Counter } from "prom-client";
import { NestrixModule } from "../../src/index.js";

const failedExports = new Counter({
  name: "telemetry_export_failures_total",
  help: "Telemetry exports that failed after the exporter's retries",
  labelNames: ["signal", "reason"],
});

@Module({
  imports: [
    NestrixModule.forRoot({
      export: {
        // Called once per failed export, on the exporter's timer: keep it synchronous and cheap.
        onFailure: ({ signal, reason }) =>
          failedExports.inc({ signal, reason }),
      },
    }),
  ],
})
export class AppModule {}
