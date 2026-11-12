import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { ApiError, ApiErrorCode } from "@nestrix-js/protocol";

/** Headers on every query API response, errors included. There is never an `Access-Control-*`. */
export const QUERY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function codeOf(status: number): ApiErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 411) return "length_required";
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "too_many_requests";
  if (status === 503) return "unavailable";
  return "internal";
}

function messageOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === "string") return body;
  if (typeof body === "object" && body !== null && "error" in body) {
    // A body that is already an ApiError (the controller's 400 and 404).
    const inner = (body as { error: unknown }).error;
    if (typeof inner === "object" && inner !== null && "message" in inner) {
      const message = (inner as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  if (typeof body === "object" && body !== null && "message" in body) {
    const message = (body as { message: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.join("; ");
  }
  return exception.message;
}

/**
 * Renders every failure of the query API as an `ApiError`. An `HttpException` keeps its status and
 * message; anything else is a 500 whose message says nothing about the cause (it is logged).
 */
@Catch()
export class QueryExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("NestrixQuery");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
      setHeader(name: string, value: string): void;
      headersSent?: boolean;
    }>();
    let status = 500;
    let message = "The query failed.";
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = messageOf(exception);
    } else {
      this.logger.error(
        `query failed: ${(exception as Error)?.message ?? String(exception)}`,
      );
    }
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(QUERY_HEADERS)) {
      res.setHeader(name, value);
    }
    const body: ApiError = { error: { code: codeOf(status), message } };
    res.status(status).json(body);
  }
}
