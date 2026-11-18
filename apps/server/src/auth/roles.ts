/**
 * Roles on the routes (issue #34, D-104).
 *
 * Three layers keep a viewer from changing anything:
 *
 * 1. `AdminAuth.middleware()` answers 403 to every request with a method other than `GET`/`HEAD`
 *    from a viewer session, before any route (so a write route added later is admin-only without
 *    any wiring).
 * 2. The global `AdminAuthGuard` refuses the same for every controller.
 * 3. `@AdminOnly()` on each write route and on admin-only reads (the token list, the audit log):
 *    `AdminRoleGuard` lets the route run only for a session whose role is `admin` (401 without a
 *    session, 403 for a viewer or an API token). `test/auth/roles.test.ts` fails when a write
 *    route lacks it.
 *
 * `@Audited(action)` records a successful call in the audit log (`AuditInterceptor`), with the
 * route's `:id` or the created object's id as the target.
 */
import {
  applyDecorators,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiError, AuditAction } from "@nestrix-js/protocol";
import { concatMap, from, map, type Observable } from "rxjs";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { stampOf } from "./admin-auth.js";
import { AuditLog } from "./audit.js";
import { clientAddressOf } from "./client-address.js";
import { actorOf, principalOf } from "./principal.js";

export const VIEWER_READ_ONLY =
  "Your role is viewer: you can read everything but change nothing. Ask an admin.";

function refuse(status: 401 | 403, message: string): never {
  const body: ApiError = {
    error: { code: status === 401 ? "unauthorized" : "forbidden", message },
  };
  throw new HttpException(body, status);
}

/** True for a request the middleware stamped as a session whose role is `admin`. */
export function isAdminRequest(req: unknown): boolean {
  return stampOf(req) === "session" && principalOf(req)?.role === "admin";
}

/** Lets a route run only for an admin session (see the file comment). */
@Injectable()
export class AdminRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    let verdict: "ok" | 401 | 403 = 401;
    try {
      if (context.getType() === "http") {
        const req = context.switchToHttp().getRequest();
        if (stampOf(req) !== "session") verdict = 401;
        else if (principalOf(req)?.role === "admin") verdict = "ok";
        else verdict = 403;
      }
    } catch {
      verdict = 401;
    }
    if (verdict === 401) refuse(401, "Sign in at /login.");
    if (verdict === 403) refuse(403, VIEWER_READ_ONLY);
    return true;
  }
}

/** Marks a route (or a controller) admin-only: `UseGuards(AdminRoleGuard)`. */
export const AdminOnly = () => UseGuards(AdminRoleGuard);

export const AUDIT_ACTION = "nestrix-server:audit-action";

/** The id of what a write changed: the route's `:id`, else the created object's. */
function targetOf(req: unknown, body: unknown): string | undefined {
  try {
    const params = (req as { params?: Record<string, unknown> }).params;
    const id = params?.id;
    if (typeof id === "string" && id !== "") return id.slice(0, 64);
    if (body !== null && typeof body === "object") {
      const b = body as Record<string, unknown>;
      for (const candidate of [
        b.id,
        (b.token as Record<string, unknown> | undefined)?.id,
        (b.rule as Record<string, unknown> | undefined)?.id,
      ]) {
        if (typeof candidate === "string" || typeof candidate === "number")
          return String(candidate).slice(0, 64);
      }
    }
  } catch {
    // No target.
  }
  return undefined;
}

/**
 * Records a successful audited call (status below 400) before the answer goes out. Every step is
 * guarded: the interceptor never changes the route's answer or turns it into an error.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditLog,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    let action: AuditAction | undefined;
    try {
      action = this.reflector.get<AuditAction | undefined>(
        AUDIT_ACTION,
        context.getHandler(),
      );
    } catch {
      action = undefined;
    }
    if (action === undefined || context.getType() !== "http")
      return next.handle();
    const http = context.switchToHttp();
    return next.handle().pipe(
      concatMap((body: unknown) => {
        let write: Promise<void> = Promise.resolve();
        try {
          const req = http.getRequest();
          const status = Number(
            (http.getResponse() as { statusCode?: unknown }).statusCode ?? 200,
          );
          if (status < 400) {
            write = this.audit.record({
              actor: actorOf(principalOf(req)),
              action: action as AuditAction,
              outcome: "ok",
              target: targetOf(req, body),
              clientAddress: clientAddressOf(req, this.config.trustedProxies),
            });
          }
        } catch {
          write = Promise.resolve();
        }
        return from(write.catch(() => undefined)).pipe(map(() => body));
      }),
    );
  }
}

/** Records the route in the audit log as `action` when it succeeds. */
export const Audited = (action: AuditAction) =>
  applyDecorators(
    SetMetadata(AUDIT_ACTION, action),
    UseInterceptors(AuditInterceptor),
  );
