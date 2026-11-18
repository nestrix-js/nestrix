import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { IngestController } from "../ingest/ingest.controller.js";
import { InstanceController } from "../profiler/instance.controller.js";
import { RemoteProfilesController } from "../profiler/remote-profiles.controller.js";
import { QueryController } from "../query/query.controller.js";
import { stampOf } from "./admin-auth.js";
import { AuthController } from "./auth.controller.js";
import { principalOf } from "./principal.js";

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
 * - `session`: a valid session; any controller. A viewer's session (issue #34) only with
 *   `GET`/`HEAD`: any other method is refused with 403, so a write route is admin-only even
 *   without `@AdminOnly()` (which every write route also carries, see roles.ts).
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
    let viewerWrite = false;
    try {
      if (context.getType() !== "http") return true;
      const req = context.switchToHttp().getRequest<{ method?: unknown }>();
      const stamp = stampOf(req);
      const target = context.getClass();
      const safe =
        typeof req.method === "string" &&
        SAFE_METHODS.has(req.method.toUpperCase());
      viewerWrite =
        stamp === "session" && principalOf(req)?.role !== "admin" && !safe;
      allowed =
        (stamp === "session" && !viewerWrite) ||
        (stamp === "token" &&
          TOKEN_CONTROLLERS.has(target) &&
          typeof req.method === "string" &&
          SAFE_METHODS.has(req.method.toUpperCase())) ||
        (stamp === "ingest" && INGEST_CONTROLLERS.has(target)) ||
        (stamp === "login" && target === AuthController);
    } catch {
      allowed = false;
    }
    if (viewerWrite) throw new ForbiddenException();
    if (!allowed) throw new UnauthorizedException();
    return true;
  }
}
