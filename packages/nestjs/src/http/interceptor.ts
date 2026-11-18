/**
 * Handler attribution and exceptions (architecture §4.2, backlog P1-07).
 *
 * A global interceptor (`APP_INTERCEPTOR`) that, for HTTP requests Nestrix has a server span for:
 * - sets `code.function.name` to `Controller.handler`;
 * - marks the request state as reached (the 404 rule in `server.ts` reads it);
 * - records an exception thrown by a handler or a pipe as an event on the server span, and
 *   notes the status it maps to. Error status is decided at `close` (`server.ts`). The event is
 *   marked `nestrix.exception.propagated` when a method span already recorded the same error,
 *   and `nestrix.exception.expected` when it is expected (`errors/exception.ts`, D-93, D-94).
 *
 * It calls `next.handle()` exactly once, outside its guard, and returns that stream with a
 * `tap` whose error callback is guarded: values, completion and the error itself (same object)
 * pass through unchanged. Guards run before interceptors, so their exceptions are not seen here
 * (level 1, D-47).
 */
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { ATTR_CODE_FUNCTION_NAME } from "@opentelemetry/semantic-conventions";
import { type Observable, tap } from "rxjs";
import { diagnostics } from "../diagnostics.js";
import {
  exceptionStatus,
  exceptionType,
  recordExceptionEvent,
} from "../errors/exception.js";
import { interceptRpc } from "../microservices/server.js";
import type { ResolvedOptions } from "../resolve-options.js";
import { NESTRIX_OPTIONS } from "../tokens.js";
import {
  getStateForRequest,
  maybeFault,
  type RequestState,
} from "./request-state.js";

export { exceptionStatus, exceptionType } from "../errors/exception.js";

function recordException(state: RequestState, error: unknown): void {
  try {
    maybeFault("interceptor-error");
    if (state.exception !== undefined) return; // first exception wins; one per request
    state.exception = {
      status: exceptionStatus(error),
      type: exceptionType(error),
    };
    // Marked propagated when a method span below already recorded the same error (D-93).
    recordExceptionEvent(state.span, error, { root: true });
  } catch (failure) {
    diagnostics.countFailure("http.interceptor-error", failure);
  }
}

/**
 * The request of an HTTP context. `getArgByIndex(0)` is what `switchToHttp().getRequest()` returns,
 * without `switchToHttp()` assigning three fresh closures onto the host's context object on every
 * request (P2-15). A context without `getArgByIndex` takes the long way.
 */
function requestOf(context: ExecutionContext): unknown {
  return typeof context.getArgByIndex === "function"
    ? context.getArgByIndex(0)
    : context.switchToHttp().getRequest();
}

@Injectable()
export class NestrixInterceptor implements NestInterceptor {
  // `options` is absent only when built by hand (tests); the module always injects it.
  constructor(
    @Inject(NESTRIX_OPTIONS) private readonly options?: ResolvedOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Microservice handlers (P4-01): traced in `microservices/server.ts`; never throws, and calls
    // `next.handle()` only when it returns a stream.
    // Skipped when this app is disabled: the microservices switch is process-wide.
    if (this.options?.enabled !== false) {
      const rpc = interceptRpc(context, next);
      if (rpc !== undefined) return rpc;
    }
    let state: RequestState | undefined;
    try {
      maybeFault("interceptor");
      if (context.getType() === "http") {
        state = getStateForRequest(requestOf(context));
        if (state) {
          state.reached = true;
          const className = context.getClass()?.name;
          const handlerName = context.getHandler()?.name;
          if (className && handlerName) {
            state.span.setAttribute(
              ATTR_CODE_FUNCTION_NAME,
              `${className}.${handlerName}`,
            );
          }
        }
      }
    } catch (error) {
      diagnostics.countFailure("http.interceptor", error);
      state = undefined;
    }
    const stream = next.handle();
    if (state === undefined) return stream;
    const found = state;
    try {
      return stream.pipe(
        tap({ error: (error: unknown) => recordException(found, error) }),
      );
    } catch (error) {
      diagnostics.countFailure("http.interceptor", error);
      return stream;
    }
  }
}
