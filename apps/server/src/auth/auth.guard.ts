import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { IngestController } from "../ingest/ingest.controller.js";
import { InstanceController } from "../profiler/instance.controller.js";
import { RemoteProfilesController } from "../profiler/remote-profiles.controller.js";
import { QueryController } from "../query/query.controller.js";
import { stampOf } from "./admin-auth.js";
import { AuthController } from "./auth.controller.js";

const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** Controllers an API token may reach, with `GET`/`HEAD` only: the read routes. */
const TOKEN_CONTROLLERS: ReadonlySet<unknown> = new Set([
  QueryController,
  RemoteProfilesController,
]);
/** Controllers that authenticate with an ingest key themselves. */
const INGEST_CONTROLLERS: ReadonlySet<unknown> = new Set([
  IngestController,
  InstanceController,
]);

/**
 * Second layer behind `AdminAuth.middleware()`, registered with `APP_GUARD`, so it covers every
 * controller of the application, including ones added later such as the query API. A controller
 * runs only when the middleware stamped the request:
 *
 * - `session`: a valid admin session; any controller.
 * - `token`: a valid API token (P8-01); only `QueryController` and `RemoteProfilesController`
 *   (the read routes of the query API), and only for `GET`/`HEAD`. Never the alert, SLO or token
 *   controllers, never the start of a remote capture.
 * - `ingest`: only `IngestController` and `InstanceController` (remote profiling's instance
 *   routes, P10-02); both check the ingest key themselves.
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
          TOKEN_CONTROLLERS.has(target) &&
          typeof req.method === "string" &&
          SAFE_METHODS.has(req.method.toUpperCase())) ||
        (stamp === "ingest" && INGEST_CONTROLLERS.has(target)) ||
        (stamp === "login" && target === AuthController);
    } catch {
      allowed = false;
    }
    if (!allowed) throw new UnauthorizedException();
    return true;
  }
}
