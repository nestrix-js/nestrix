/**
 * SLOs in the standalone server (docs/backlog/phase-7.md, P7-04): definitions, status computed
 * from the route rollups, and the admin API `/api/v1/slos`. Burn-rate alerts live in the alerting
 * engine (`alerts/metrics.ts`). Needs `StorageModule` (global: `STORAGE_POOL`).
 */
import { Module } from "@nestjs/common";
import { SlosController } from "./slos.controller.js";
import { SlosService } from "./slos.service.js";

@Module({
  controllers: [SlosController],
  providers: [SlosService],
})
export class SlosModule {}
