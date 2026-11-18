import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { AdminAuth } from "./admin-auth.js";
import { AuthModule } from "./auth.module.js";
import {
  PostgresLoginLimiter,
  PostgresSessionRevocations,
} from "./session-store.js";

/** Hands the shared stores to `AdminAuth` before the server listens. */
@Injectable()
export class SessionStoreRegistration implements OnModuleInit {
  constructor(
    private readonly auth: AdminAuth,
    @Inject(PostgresSessionRevocations)
    private readonly revocations: PostgresSessionRevocations,
    @Inject(PostgresLoginLimiter)
    private readonly limiter: PostgresLoginLimiter,
  ) {}

  onModuleInit(): void {
    this.auth.useSharedState(this.revocations, this.limiter);
  }
}

/**
 * Admin sessions and the login limiter shared by every server instance (issue #31, D-96):
 * logout revocations, the per-client `/login` window and the global failure budget in PostgreSQL.
 * Needs `StorageModule` (global: `STORAGE_POOL`; its migrations create the tables). Without this
 * module (the receiver-only test app) `AdminAuth` keeps them in process.
 */
@Module({
  imports: [AuthModule],
  providers: [
    {
      provide: PostgresSessionRevocations,
      inject: [STORAGE_POOL],
      useFactory: (pool: Pool) => new PostgresSessionRevocations(pool),
    },
    {
      provide: PostgresLoginLimiter,
      inject: [STORAGE_POOL],
      useFactory: (pool: Pool) => new PostgresLoginLimiter(pool),
    },
    SessionStoreRegistration,
  ],
  exports: [PostgresSessionRevocations, PostgresLoginLimiter],
})
export class SessionStoreModule {}
