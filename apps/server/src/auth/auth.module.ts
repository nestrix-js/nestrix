import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AdminAuth } from "./admin-auth.js";
import { AuthController } from "./auth.controller.js";
import { AdminAuthGuard } from "./auth.guard.js";

/**
 * The admin login. `configureApp` mounts `AdminAuth.middleware()` (resolving `AdminAuth` from this
 * module); `AdminAuthGuard` is global. Needs `SERVER_CONFIG` (the global config module).
 */
@Module({
  controllers: [AuthController],
  providers: [AdminAuth, { provide: APP_GUARD, useClass: AdminAuthGuard }],
  exports: [AdminAuth],
})
export class AuthModule {}
