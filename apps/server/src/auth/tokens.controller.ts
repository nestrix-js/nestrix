import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type {
  ApiError,
  ApiErrorCode,
  ApiTokenCreateResponse,
  ApiTokenListResponse,
} from "@nestrix-js/protocol";
import {
  QUERY_HEADERS,
  QueryExceptionFilter,
} from "../query/exception.filter.js";
import {
  ApiTokenStore,
  MAX_ACTIVE_TOKENS,
  TooManyTokensError,
  validateTokenCreate,
} from "./api-tokens.js";
import { SessionQueryGuard } from "./query-guard.js";

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

function parseId(raw: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    apiError(
      400,
      "bad_request",
      "The token id must be a positive whole number.",
    );
  }
  return Number(raw);
}

/**
 * `/api/v1/tokens`: create, list and revoke API tokens (docs/backlog/phase-8.md P8-01).
 *
 * Session only: `AdminAuth.middleware()` never lets a token-authenticated request reach this path
 * (tokens read only the query API's read routes), the global `AdminAuthGuard` lets a `token`
 * stamp reach only `QueryController`, and `SessionQueryGuard` here accepts only `session`. So a
 * token can never create, list or revoke tokens. Writes also need the middleware's same-origin
 * `Origin`. Responses are `no-store`; the secret appears only in the `POST` answer.
 */
@Controller("api/v1/tokens")
@UseGuards(SessionQueryGuard)
@UseFilters(QueryExceptionFilter)
export class TokensController {
  constructor(private readonly tokens: ApiTokenStore) {}

  @Get()
  @Headers()
  async list(): Promise<ApiTokenListResponse> {
    return { tokens: await this.tokens.list() };
  }

  @Post()
  @HttpCode(201)
  @Headers()
  async create(@Body() body: unknown): Promise<ApiTokenCreateResponse> {
    const v = validateTokenCreate(body);
    if (!v.ok) apiError(400, "bad_request", v.message);
    try {
      return await this.tokens.create(v.name);
    } catch (error) {
      if (error instanceof TooManyTokensError) {
        apiError(
          400,
          "bad_request",
          `At most ${MAX_ACTIVE_TOKENS} tokens can be active; revoke one first.`,
        );
      }
      throw error;
    }
  }

  @Delete(":id")
  @HttpCode(204)
  @Headers()
  async revoke(@Param("id") id: string): Promise<void> {
    if (!(await this.tokens.revoke(parseId(id)))) {
      apiError(404, "not_found", "No such token.");
    }
  }
}
