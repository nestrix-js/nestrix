import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type {
  AlertEventListResponse,
  AlertRule,
  AlertRuleCreateResponse,
  AlertRuleListResponse,
  AlertTestResponse,
  ApiError,
  ApiErrorCode,
} from "@nestrix/protocol";
import { SessionQueryGuard } from "../auth/query-guard.js";
import {
  QUERY_HEADERS,
  QueryExceptionFilter,
} from "../query/exception.filter.js";
import { AlertsService } from "./alerts.service.js";
import { validateRuleInput } from "./store.js";
import { ALERTS_OPTIONS, type ResolvedAlertsOptions } from "./tokens.js";

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
      "The rule id must be a positive whole number.",
    );
  }
  return Number(raw);
}

function notFound(): never {
  apiError(404, "not_found", "No such alert rule.");
}

interface RequestLike {
  originalUrl?: string;
  url?: string;
}

/**
 * `/api/v1/alerts`: alert rules and their history (docs/backlog/phase-7.md, P7-03).
 *
 * Access: the admin login's middleware and global guard cover this controller like every other
 * (a session is required; a state-changing method also needs a same-origin `Origin`), and
 * `SessionQueryGuard` checks the session stamp again here. No CORS headers are ever sent.
 */
@Controller("api/v1/alerts")
@UseGuards(SessionQueryGuard)
@UseFilters(QueryExceptionFilter)
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    @Inject(ALERTS_OPTIONS) private readonly options: ResolvedAlertsOptions,
  ) {}

  @Get()
  @Headers()
  async list(): Promise<AlertRuleListResponse> {
    return { rules: await this.alerts.list() };
  }

  @Post()
  @HttpCode(201)
  @Headers()
  async create(@Body() body: unknown): Promise<AlertRuleCreateResponse> {
    const v = validateRuleInput(body, false, this.options.allowedHosts);
    if (!v.ok) apiError(400, "bad_request", v.message);
    return this.alerts.create(v.fields);
  }

  /** `?rule=<id>&limit=<1..200, default 50>`, newest first. */
  @Get("events")
  @Headers()
  async events(@Req() req: RequestLike): Promise<AlertEventListResponse> {
    const raw = req.originalUrl ?? req.url ?? "";
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    const params = new URLSearchParams(query);
    let rule: number | undefined;
    let limit = 50;
    const seen = new Set<string>();
    for (const [key, value] of params) {
      if (seen.has(key))
        apiError(
          400,
          "bad_request",
          `Repeated parameter: ${key.slice(0, 64)}.`,
        );
      seen.add(key);
      if (key === "rule") rule = parseId(value);
      else if (key === "limit") {
        if (
          !/^[0-9]{1,3}$/.test(value) ||
          Number(value) < 1 ||
          Number(value) > 200
        ) {
          apiError(
            400,
            "bad_request",
            "limit must be a whole number from 1 to 200.",
          );
        }
        limit = Number(value);
      } else {
        apiError(400, "bad_request", `Unknown parameter: ${key.slice(0, 64)}.`);
      }
    }
    return { events: await this.alerts.events(rule, limit) };
  }

  @Get(":id")
  @Headers()
  async get(@Param("id") id: string): Promise<AlertRule> {
    return (await this.alerts.get(parseId(id))) ?? notFound();
  }

  @Patch(":id")
  @Headers()
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<AlertRule> {
    const ruleId = parseId(id);
    const existing = await this.alerts.row(ruleId);
    if (existing === undefined) notFound();
    const v = validateRuleInput(
      body,
      true,
      this.options.allowedHosts,
      existing,
    );
    if (!v.ok) apiError(400, "bad_request", v.message);
    return (await this.alerts.update(ruleId, v.fields)) ?? notFound();
  }

  @Delete(":id")
  @HttpCode(204)
  @Headers()
  async remove(@Param("id") id: string): Promise<void> {
    if (!(await this.alerts.remove(parseId(id)))) notFound();
  }

  @Post(":id/test")
  @HttpCode(200)
  @Headers()
  async test(@Param("id") id: string): Promise<AlertTestResponse> {
    const event = await this.alerts.testSend(parseId(id));
    return { event: event ?? notFound() };
  }
}
