import {
  applyDecorators,
  Controller,
  Get,
  Header,
  HttpException,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type {
  ApiError,
  AuditListResponse,
  ParamSpec,
} from "@nestrix-js/protocol";
import {
  QUERY_HEADERS,
  QueryExceptionFilter,
} from "../query/exception.filter.js";
import { parseQuery } from "../query/params.js";
import { AuditLog } from "./audit.js";
import { SessionQueryGuard } from "./query-guard.js";
import { AdminOnly } from "./roles.js";

const Headers = () =>
  applyDecorators(
    ...Object.entries(QUERY_HEADERS).map(([name, value]) =>
      Header(name, value),
    ),
  );

const listSpec: Readonly<Record<string, ParamSpec>> = {
  limit: { kind: "int", min: 1, max: 200 },
  before: { kind: "string", maxLength: 20 },
};

/**
 * `GET /api/v1/audit`: the audit log, newest first (issue #34, D-104). Admin sessions only: the
 * middleware never lets an API token reach this path (it is not a token read route), the global
 * guard admits a token only to the query controllers, and `@AdminOnly()` refuses a viewer.
 */
@Controller("api/v1/audit")
@UseGuards(SessionQueryGuard)
@AdminOnly()
@UseFilters(QueryExceptionFilter)
export class AuditController {
  constructor(private readonly audit: AuditLog) {}

  @Get()
  @Headers()
  async list(
    @Req() req: { originalUrl?: string; url?: string },
  ): Promise<AuditListResponse> {
    const parsed = parseQuery(req.originalUrl ?? req.url, listSpec);
    if (!parsed.ok) {
      const body: ApiError = {
        error: { code: "bad_request", message: parsed.message },
      };
      throw new HttpException(body, 400);
    }
    const before = parsed.values.before;
    if (
      before !== undefined &&
      before !== "" &&
      !/^[1-9][0-9]{0,18}$/.test(String(before))
    ) {
      const body: ApiError = {
        error: {
          code: "bad_request",
          message: "before must be an entry id.",
        },
      };
      throw new HttpException(body, 400);
    }
    const limit =
      typeof parsed.values.limit === "number" ? parsed.values.limit : 100;
    return {
      entries: await this.audit.list(
        limit,
        before === undefined || before === "" ? undefined : String(before),
      ),
    };
  }
}
