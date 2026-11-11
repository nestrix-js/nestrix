import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { IngestController } from "../ingest/ingest.controller.js";
import { stampOf } from "./admin-auth.js";
import { AuthController } from "./auth.controller.js";

/**
 * Second layer behind `AdminAuth.middleware()`, registered with `APP_GUARD`, so it covers every
 * controller of the application, including ones added later such as the query API. A controller
 * runs only when the middleware stamped the request:
 *
 * - `session`: a valid admin session; any controller.
 * - `ingest`: only `IngestController`.
 * - `login`: only `AuthController`.
 *
 * No stamp (the middleware was not mounted, or an unexpected route matched an exempt path) is
 * refused with 401. Non-HTTP contexts are not guarded (the server has none).
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    let allowed = false;
    try {
      if (context.getType() !== "http") return true;
      const stamp = stampOf(context.switchToHttp().getRequest());
      const target = context.getClass();
      allowed =
        stamp === "session" ||
        (stamp === "ingest" && target === IngestController) ||
        (stamp === "login" && target === AuthController);
    } catch {
      allowed = false;
    }
    if (!allowed) throw new UnauthorizedException();
    return true;
  }
}
