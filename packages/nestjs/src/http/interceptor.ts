/**
 * Handler attribution and exceptions (architecture §4.2, backlog P1-07).
 *
 * A global interceptor (`APP_INTERCEPTOR`) that, for HTTP requests Nestrix has a server span for:
 * - sets `code.function.name` to `Controller.handler`;
 * - marks the request state as reached (the 404 rule in `server.ts` reads it);
 * - records an exception thrown by a handler or a pipe as an event on the server span, and
 *   notes the status it maps to. Error status is decided at `close` (`server.ts`).
 *
 * It calls `next.handle()` exactly once, outside its guard, and returns that stream with a
 * `tap` whose error callback is guarded: values, completion and the error itself (same object)
 * pass through unchanged. Guards run before interceptors, so their exceptions are not seen here
 * (level 1, D-47).
 */
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { ATTR_CODE_FUNCTION_NAME } from "@opentelemetry/semantic-conventions";
import { type Observable, tap } from "rxjs";
import { diagnostics } from "../diagnostics.js";
import {
  getStateForRequest,
  maybeFault,
  type RequestState,
} from "./request-state.js";

/**
 * The status an exception maps to: `getStatus()` of an `HttpException` (duck-typed, so a second
 * copy of `@nestjs/common` still counts), otherwise 500.
 */
export function exceptionStatus(error: unknown): number {
  try {
    if (error !== null && typeof error === "object") {
      const getStatus = (error as { getStatus?: unknown }).getStatus;
      const getResponse = (error as { getResponse?: unknown }).getResponse;
      if (
        typeof getStatus === "function" &&
        typeof getResponse === "function"
      ) {
        const status: unknown = getStatus.call(error);
        if (typeof status === "number" && Number.isInteger(status))
          return status;
      }
    }
  } catch {
    // An exception whose getStatus throws is treated as unexpected.
  }
  return 500;
}

/** `error.type` for an exception: its constructor's name, else `_OTHER`. */
export function exceptionType(error: unknown): string {
  try {
    if (error !== null && typeof error === "object") {
      const name = (error as { constructor?: { name?: unknown } }).constructor
        ?.name;
      if (typeof name === "string" && name !== "") return name;
    }
  } catch {
    // Fall through.
  }
  return "_OTHER";
}

function recordException(state: RequestState, error: unknown): void {
  try {
    maybeFault("interceptor-error");
    if (state.exception !== undefined) return; // first exception wins; one per request
    state.exception = {
      status: exceptionStatus(error),
      type: exceptionType(error),
    };
    if (error instanceof Error) {
      state.span.recordException(error);
    } else {
      state.span.recordException({
        name: exceptionType(error),
        message: safeString(error),
      });
    }
  } catch (failure) {
    diagnostics.countFailure("http.interceptor-error", failure);
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "(unprintable)";
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
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
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
