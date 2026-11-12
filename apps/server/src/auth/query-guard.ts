import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { stampOf } from "./admin-auth.js";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * The guard of the admin-only APIs (alerts, SLOs, tokens): defence in depth behind
 * `AdminAuth.middleware()` and the global `AdminAuthGuard`. It opens a route only for a request
 * the middleware stamped as a valid admin session; anything else, an API token included, is
 * refused with 401.
 */
@Injectable()
export class SessionQueryGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    let allowed = false;
    try {
      allowed =
        context.getType() === "http" &&
        stampOf(context.switchToHttp().getRequest()) === "session";
    } catch {
      allowed = false;
    }
    if (!allowed) throw new UnauthorizedException();
    return true;
  }
}

/**
 * The query API's guard (`QUERY_GUARD`): a valid admin session, or a valid API token (P8-01) on a
 * `GET`/`HEAD`. Behind the middleware, which already limits tokens to the read routes, and the
 * global `AdminAuthGuard`, which limits them to `QueryController`.
 */
@Injectable()
export class ReadQueryGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    let allowed = false;
    try {
      if (context.getType() === "http") {
        const req = context.switchToHttp().getRequest<{ method?: unknown }>();
        const stamp = stampOf(req);
        allowed =
          stamp === "session" ||
          (stamp === "token" &&
            typeof req.method === "string" &&
            SAFE_METHODS.has(req.method.toUpperCase()));
      }
    } catch {
      allowed = false;
    }
    if (!allowed) throw new UnauthorizedException();
    return true;
  }
}
