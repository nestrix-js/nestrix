/**
 * The access hook of the query API.
 *
 * Every route of `QueryController` runs `QueryGuardGate`, which delegates to whatever provider
 * holds the `QUERY_GUARD` token (a Nest `CanActivate`). `QueryModule.forRoot({ guard })` chooses
 * that provider; without one the default is `DenyQueryGuard`, so the API is closed unless
 * something positive opens it (architecture §4.7). P5-04 supplies the admin-session guard:
 *
 * ```ts
 * QueryModule.forRoot({
 *   imports: [AuthModule],              // modules the guard's own dependencies come from
 *   guard: { useClass: SessionGuard },  // or { useExisting: SessionGuard }, { useFactory, inject }
 * })
 * ```
 *
 * A guard denies by returning `false` (Nest's 403) or by throwing an `HttpException` (for example
 * 401 or 503); `QueryExceptionFilter` renders either as the protocol's `ApiError`.
 */
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";

/** Injection token of the guard the query API runs on every request. */
export const QUERY_GUARD = Symbol("nestrix-server:query-guard");

/** The default guard: denies every request until a real guard is configured. */
@Injectable()
export class DenyQueryGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException(
      "The query API has no access guard configured, so it is closed.",
    );
  }
}

/** What `QueryController` is decorated with: forwards to the `QUERY_GUARD` provider. */
@Injectable()
export class QueryGuardGate implements CanActivate {
  constructor(@Inject(QUERY_GUARD) private readonly guard: CanActivate) {}

  canActivate(context: ExecutionContext) {
    return this.guard.canActivate(context);
  }
}
