import { Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { AdminAuth } from "./admin-auth.js";
import { ApiTokenStore } from "./api-tokens.js";
import { AuthModule } from "./auth.module.js";
import { TokensController } from "./tokens.controller.js";

/** Hands the store to `AdminAuth`, whose middleware verifies `Bearer nxt_…` with it. */
@Injectable()
export class TokenVerifierRegistration implements OnModuleInit {
  constructor(
    private readonly auth: AdminAuth,
    private readonly store: ApiTokenStore,
  ) {}

  onModuleInit(): void {
    this.auth.useTokenVerifier(this.store);
  }
}

/**
 * API tokens (docs/backlog/phase-8.md P8-01): the store, `/api/v1/tokens`, and the verifier the
 * admin login's middleware uses. Needs `StorageModule` (global: `STORAGE_POOL`). Without this
 * module (the receiver-only test app), every `Bearer nxt_…` request is refused.
 */
@Module({
  imports: [AuthModule],
  controllers: [TokensController],
  providers: [ApiTokenStore, TokenVerifierRegistration],
  exports: [ApiTokenStore],
})
export class TokensModule {}
