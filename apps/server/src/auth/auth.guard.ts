import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { IngestController } from "../ingest/ingest.controller.js";
import { QueryController } from "../query/query.controller.js";
import { stampOf } from "./admin-auth.js";
import { AuthController } from "./auth.controller.js";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Second layer behind `AdminAuth.middleware()`, registered with `APP_GUARD`, so it covers every
 * controller of the application, including ones added later such as the query API. A controller
 * runs only when the middleware stamped the request:
 *
 * - `session`: a valid admin session; any controller.
 * - `token`: a valid API token (P8-01); only `QueryController` (the read routes of the query API),
 *   and only for `GET`/`HEAD`. Never the alert, SLO or token controllers.
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
      const req = context.switchToHttp().getRequest<{ method?: unknown }>();
      const stamp = stampOf(req);
      const target = context.getClass();
      allowed =
        stamp === "session" ||
        (stamp === "token" &&
          target === QueryController &&
          typeof req.method === "string" &&
          SAFE_METHODS.has(req.method.toUpperCase())) ||
        (stamp === "ingest" && target === IngestController) ||
        (stamp === "login" && target === AuthController);
    } catch {
      allowed = false;
    }
    if (!allowed) throw new UnauthorizedException();
    return true;
  }
}
