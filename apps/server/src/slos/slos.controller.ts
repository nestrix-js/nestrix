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
  Patch,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type {
  ApiError,
  ApiErrorCode,
  Slo,
  SloListResponse,
} from "@nestrix/protocol";
import { SessionQueryGuard } from "../auth/query-guard.js";
import {
  QUERY_HEADERS,
  QueryExceptionFilter,
} from "../query/exception.filter.js";
import { SlosService } from "./slos.service.js";
import { validateSloInput } from "./store.js";

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
    apiError(400, "bad_request", "The SLO id must be a positive whole number.");
  }
  return Number(raw);
}

function notFound(): never {
  apiError(404, "not_found", "No such SLO.");
}

/**
 * `/api/v1/slos`: SLO definitions with their computed status (docs/backlog/phase-7.md, P7-04).
 *
 * Access is the alerts controller's: the admin login's middleware and global guard (a session; a
 * state-changing method also needs a same-origin `Origin`), `SessionQueryGuard` again here, and
 * no CORS headers.
 */
@Controller("api/v1/slos")
@UseGuards(SessionQueryGuard)
@UseFilters(QueryExceptionFilter)
export class SlosController {
  constructor(private readonly slos: SlosService) {}

  @Get()
  @Headers()
  async list(): Promise<SloListResponse> {
    return { slos: await this.slos.list() };
  }

  @Post()
  @HttpCode(201)
  @Headers()
  async create(@Body() body: unknown): Promise<Slo> {
    const v = validateSloInput(body, false);
    if (!v.ok) apiError(400, "bad_request", v.message);
    return this.slos.create(v.fields);
  }

  @Get(":id")
  @Headers()
  async get(@Param("id") id: string): Promise<Slo> {
    return (await this.slos.get(parseId(id))) ?? notFound();
  }

  @Patch(":id")
  @Headers()
  async update(@Param("id") id: string, @Body() body: unknown): Promise<Slo> {
    const sloId = parseId(id);
    const existing = await this.slos.row(sloId);
    if (existing === undefined) notFound();
    const v = validateSloInput(body, true, existing);
    if (!v.ok) apiError(400, "bad_request", v.message);
    return (await this.slos.update(sloId, v.fields)) ?? notFound();
  }

  @Delete(":id")
  @HttpCode(204)
  @Headers()
  async remove(@Param("id") id: string): Promise<void> {
    if (!(await this.slos.remove(parseId(id)))) notFound();
  }
}
