import {
  applyDecorators,
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { ApiError, QuerySort } from "@nestrix-js/protocol";
import { QUERY_HEADERS, QueryExceptionFilter } from "./exception.filter.js";
import { QueryGuardGate } from "./guard.js";
import {
  appMapSpec,
  classStatsSpec,
  dependencySpec,
  errorGroupSpec,
  errorListSpec,
  metaSpec,
  type Parsed,
  parseQuery,
  queryStatsSpec,
  routeCompareSpec,
  routeHistogramSpec,
  routeStatsSpec,
  traceListSpec,
  traceSpec,
  traceTimelineSpec,
  type Values,
} from "./params.js";
import { NotFoundError, QueryService } from "./query.service.js";
import { TraceLogsService } from "./trace-logs.service.js";

interface RequestLike {
  originalUrl?: string;
  url?: string;
}

/** The headers every query response carries (`no-store`, `nosniff`); never `Access-Control-*`. */
const Headers = () =>
  applyDecorators(
    ...Object.entries(QUERY_HEADERS).map(([name, value]) =>
      Header(name, value),
    ),
  );

function parse(
  req: RequestLike,
  spec: Parameters<typeof parseQuery>[1],
): Values {
  const parsed: Parsed = parseQuery(req.originalUrl ?? req.url, spec);
  if (!parsed.ok) {
    const body: ApiError = {
      error: { code: "bad_request", message: parsed.message },
    };
    throw new HttpException(body, 400);
  }
  return parsed.values;
}

/**
 * `/api/v1/*`: the routes of the embedded dashboard's API with the same shapes and parameter
 * checks, plus `service`. Every route runs the `QUERY_GUARD` provider first (`guard.ts`).
 */
@Controller("api/v1")
@UseGuards(QueryGuardGate)
@UseFilters(QueryExceptionFilter)
export class QueryController {
  constructor(private readonly query: QueryService) {}

  @Inject(TraceLogsService)
  private readonly traceLogsService!: TraceLogsService;

  @Get("meta")
  @Headers()
  meta(@Req() req: RequestLike) {
    parse(req, metaSpec);
    return this.query.meta();
  }

  @Get("traces")
  @Headers()
  traces(@Req() req: RequestLike) {
    return this.query.listTraces(parse(req, traceListSpec));
  }

  @Get("traces/timeline")
  @Headers()
  timeline(@Req() req: RequestLike) {
    return this.query.timeline(parse(req, traceTimelineSpec));
  }

  @Get("trace")
  @Headers()
  async trace(@Req() req: RequestLike) {
    const id = parse(req, traceSpec).id;
    if (typeof id !== "string") {
      const body: ApiError = {
        error: {
          code: "bad_request",
          message: 'Query parameter "id" is required.',
        },
      };
      throw new HttpException(body, 400);
    }
    try {
      return await this.query.getTrace(id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new HttpException(error.message, 404);
      }
      throw error;
    }
  }

  /** P9-07: the log lines stored next to a trace; none is `200` with no items. */
  @Get("trace/logs")
  @Headers()
  traceLogs(@Req() req: RequestLike) {
    const id = parse(req, traceSpec).id;
    if (typeof id !== "string") {
      const body: ApiError = {
        error: {
          code: "bad_request",
          message: 'Query parameter "id" is required.',
        },
      };
      throw new HttpException(body, 400);
    }
    return this.traceLogsService.getTraceLogs(id);
  }

  @Get("errors")
  @Headers()
  errors(@Req() req: RequestLike) {
    return this.query.listErrors(parse(req, errorListSpec));
  }

  @Get("errors/groups")
  @Headers()
  errorGroups(@Req() req: RequestLike) {
    const v = parse(req, errorGroupSpec);
    return this.query.errorGroups(
      v.windowMinutes as number,
      v.service as string | undefined,
    );
  }

  @Get("routes")
  @Headers()
  routes(@Req() req: RequestLike) {
    const v = parse(req, routeStatsSpec);
    return this.query.routes(
      v.windowMinutes as number,
      v.service as string | undefined,
    );
  }

  @Get("routes/histogram")
  @Headers()
  routeHistogram(@Req() req: RequestLike) {
    const v = parse(req, routeHistogramSpec);
    if (typeof v.route !== "string") {
      const body: ApiError = {
        error: {
          code: "bad_request",
          message: 'Query parameter "route" is required.',
        },
      };
      throw new HttpException(body, 400);
    }
    return this.query.routeHistogram(
      v.route,
      typeof v.method === "string" ? v.method.toUpperCase() : undefined,
      v.windowMinutes as number,
      v.service as string | undefined,
    );
  }

  @Get("routes/compare")
  @Headers()
  routeCompare(@Req() req: RequestLike) {
    const v = parse(req, routeCompareSpec);
    const a = v.releaseA;
    const b = v.releaseB;
    if ((a === undefined) !== (b === undefined)) {
      const body: ApiError = {
        error: {
          code: "bad_request",
          message:
            'Query parameters "releaseA" and "releaseB" must be given together.',
        },
      };
      throw new HttpException(body, 400);
    }
    const service = v.service as string | undefined;
    if (typeof a === "string" && typeof b === "string") {
      return this.query.releaseCompare(a, b, service);
    }
    return this.query.windowCompare(v.windowMinutes as number, service);
  }

  @Get("classes")
  @Headers()
  classes(@Req() req: RequestLike) {
    const v = parse(req, classStatsSpec);
    return this.query.classes(
      v.windowMinutes as number,
      v.service as string | undefined,
    );
  }

  @Get("queries")
  @Headers()
  queries(@Req() req: RequestLike) {
    const v = parse(req, queryStatsSpec);
    return this.query.queries(
      v.windowMinutes as number,
      v.service as string | undefined,
      (v.sort as QuerySort | undefined) ?? "total",
      v.limit as number,
    );
  }

  @Get("map")
  @Headers()
  map(@Req() req: RequestLike) {
    const v = parse(req, appMapSpec);
    return this.query.map(
      v.windowMinutes as number,
      v.service as string | undefined,
    );
  }

  @Get("dependencies")
  @Headers()
  dependencies(@Req() req: RequestLike) {
    const v = parse(req, dependencySpec);
    return this.query.dependencies(
      v.windowMinutes as number,
      v.service as string | undefined,
    );
  }
}
