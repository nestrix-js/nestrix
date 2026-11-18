import {
  applyDecorators,
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type {
  ApiError,
  ApiErrorCode,
  ErrorGroupTriageResponse,
} from "@nestrix-js/protocol";
import type { Pool } from "pg";
import { SessionQueryGuard } from "../auth/query-guard.js";
import {
  QUERY_HEADERS,
  QueryExceptionFilter,
} from "../query/exception.filter.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { applyTriage, parseGroupKey, type TriageAction } from "./triage.js";

const Headers = () =>
  applyDecorators(
    ...Object.entries(QUERY_HEADERS).map(([name, value]) =>
      Header(name, value),
    ),
  );

function apiError(status: number, code: ApiErrorCode, message: string): never {
  const body: ApiError = { error: { code, message } };
  throw new HttpException(body, status);
}

/** A body of `{ key, service? }` and nothing else. */
function parseBody(body: unknown) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    apiError(400, "bad_request", "The body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  for (const k of Object.keys(input)) {
    if (k !== "key" && k !== "service") {
      apiError(400, "bad_request", `Unknown field: ${k.slice(0, 64)}.`);
    }
  }
  const parsed = parseGroupKey(input.key);
  if (parsed === undefined) {
    apiError(400, "bad_request", "key must be the key of an error group.");
  }
  let service: string | undefined;
  if (input.service !== undefined) {
    if (
      typeof input.service !== "string" ||
      input.service.length < 1 ||
      input.service.length > 256
    ) {
      apiError(400, "bad_request", "service must have 1 to 256 characters.");
    }
    service = input.service;
  }
  return { key: input.key as string, parsed, service };
}

/**
 * `POST /api/v1/errors/groups/{resolve,ignore,reopen}` (issue #26, D-103): the stored triage
 * state of an error group.
 *
 * Access is the alerts controller's: the admin login's middleware and global guard (a session;
 * a state-changing method also needs a same-origin `Origin`; an API token never reaches a write),
 * `SessionQueryGuard` again here, and no CORS headers. The `GET` routes of the same path belong to
 * `QueryController`.
 */
@Controller("api/v1/errors/groups")
@UseGuards(SessionQueryGuard)
@UseFilters(QueryExceptionFilter)
export class ErrorTriageController {
  constructor(@Inject(STORAGE_POOL) private readonly pool: Pool) {}

  private async act(
    action: TriageAction,
    body: unknown,
  ): Promise<ErrorGroupTriageResponse> {
    const v = parseBody(body);
    const done = await applyTriage(
      this.pool,
      action,
      v.key,
      v.parsed,
      v.service,
      Date.now(),
    );
    if (done === undefined) {
      apiError(404, "not_found", "No stored error group matches this key.");
    }
    return done;
  }

  @Post("resolve")
  @HttpCode(200)
  @Headers()
  resolve(@Body() body: unknown) {
    return this.act("resolve", body);
  }

  @Post("ignore")
  @HttpCode(200)
  @Headers()
  ignore(@Body() body: unknown) {
    return this.act("ignore", body);
  }

  /** Reopens a resolved or regressed group and un-ignores an ignored one. */
  @Post("reopen")
  @HttpCode(200)
  @Headers()
  reopen(@Body() body: unknown) {
    return this.act("reopen", body);
  }
}
