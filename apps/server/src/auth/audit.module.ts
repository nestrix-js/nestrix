import { Global, Module } from "@nestjs/common";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { AuditLog } from "./audit.js";
import { AdminRoleGuard, AuditInterceptor } from "./roles.js";

/**
 * The audit log and the role guard, global so every feature module's controllers can use
 * `@AdminOnly()` and `@Audited()` (issue #34, D-104). The log keeps entries in process until
 * `SessionStoreModule` hands it the PostgreSQL store at start.
 */
@Global()
@Module({
  providers: [
    {
      provide: AuditLog,
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerConfig) =>
        new AuditLog(undefined, config.retentionDays),
    },
    AuditInterceptor,
    AdminRoleGuard,
  ],
  exports: [AuditLog, AuditInterceptor, AdminRoleGuard],
})
export class AuditLogModule {}
