import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { stampOf } from "./admin-auth.js";

/**
 * The query API's guard (`QUERY_GUARD`): defence in depth behind `AdminAuth.middleware()` and the
 * global `AdminAuthGuard`. It opens the API only for a request the middleware stamped as a valid
 * admin session; anything else is refused with 401.
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
