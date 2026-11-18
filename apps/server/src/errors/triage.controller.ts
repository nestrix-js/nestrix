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
import { AdminOnly, Audited } from "../auth/roles.js";
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

/** A body of `{ key, service?, environment? }` and nothing else. */
function parseBody(body: unknown) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    apiError(400, "bad_request", "The body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  for (const k of Object.keys(input)) {
    if (k !== "key" && k !== "service" && k !== "environment") {
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
  // The environment scope (issue #28, D-101): absent is every environment, `unset` the copy
  // without one, any other value that environment.
  let environment: string | undefined;
  if (input.environment !== undefined) {
    if (
      typeof input.environment !== "string" ||
      input.environment.length < 1 ||
      input.environment.length > 256
    ) {
      apiError(
        400,
        "bad_request",
        "environment must have 1 to 256 characters.",
      );
    }
    environment = input.environment;
  }
  return { key: input.key as string, parsed, service, environment };
}

/**
 * `POST /api/v1/errors/groups/{resolve,ignore,reopen}` (issue #26, D-103): the stored triage
 * state of an error group.
 *
 * Access is the alerts controller's: the admin login's middleware and global guard (a session;
 * a state-changing method also needs a same-origin `Origin`; an API token never reaches a write),
 * `SessionQueryGuard` again here, and no CORS headers. The `GET` routes of the same path belong to
 * `QueryController`. Every route is `@AdminOnly()` (issue #34, D-104: a viewer reads the groups
 * but cannot triage them) and audited as `error_group.<action>`; the audit entry has no target
 * (the group key holds the error's normalised message, longer than the target column).
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
      v.environment,
      Date.now(),
    );
    if (done === undefined) {
      apiError(
        404,
        "not_found",
        "No stored error group matches this key. To triage a group the server has not stored yet, name its service (and its environment, when the service has environments).",
      );
    }
    return done;
  }

  @Post("resolve")
  @AdminOnly()
  @Audited("error_group.resolve")
  @HttpCode(200)
  @Headers()
  resolve(@Body() body: unknown) {
    return this.act("resolve", body);
  }

  @Post("ignore")
  @AdminOnly()
  @Audited("error_group.ignore")
  @HttpCode(200)
  @Headers()
  ignore(@Body() body: unknown) {
    return this.act("ignore", body);
  }

  /** Reopens a resolved or regressed group and un-ignores an ignored one. */
  @Post("reopen")
  @AdminOnly()
  @Audited("error_group.reopen")
  @HttpCode(200)
  @Headers()
  reopen(@Body() body: unknown) {
    return this.act("reopen", body);
  }
}
