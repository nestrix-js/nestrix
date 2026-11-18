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
import type {
  ApiError,
  MetricAggregation,
  QuerySort,
} from "@nestrix-js/protocol";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import type { TriageFilter } from "../errors/triage.js";
import { QUERY_HEADERS, QueryExceptionFilter } from "./exception.filter.js";
import { ExplainService } from "./explain.service.js";
import { QueryGuardGate } from "./guard.js";
import { LogSearchService } from "./log-search.service.js";
import { MetricsParamError, MetricsService } from "./metrics.service.js";
import { OverviewService } from "./overview.service.js";
import {
  appMapSpec,
  classStatsSpec,
  dependencySpec,
  errorGroupSpec,
  errorInsightsSpec,
  errorListSpec,
  logSearchSpec,
  metaSpec,
  metricCatalogSpec,
  metricSeriesSpec,
  overviewSpec,
  type Parsed,
  parseQuery,
  queryStatsSpec,
  routeCompareSpec,
  routeExplainSpec,
  routeHistogramSpec,
  routeStatsSpec,
  traceListSpec,
  traceSpec,
  traceTimelineSpec,
  type Values,
} from "./params.js";
import { NotFoundError, QueryService } from "./query.service.js";
import { scopeOf } from "./scope.js";
import { TraceLogsService } from "./trace-logs.service.js";
import { type ResolvedWindow, resolveWindow } from "./window.js";

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

/** `windowMinutes` or `fromUnixMs` + `toUnixMs` of a request, as a window length and its end (400 when invalid). A function, not a method: the controller's methods are its routes. */
function requestWindow(
  config: ServerConfig,
  v: Values,
  defaultWindowMinutes = 15,
): ResolvedWindow {
  return resolveWindow(v, {
    retentionDays: config.retentionDays,
    defaultWindowMinutes,
  });
}

/**
 * `/api/v1/*`: the routes of the embedded dashboard's API with the same shapes and parameter
 * checks, plus `service` and `environment` (D-101: `scope.ts`). Every route runs the `QUERY_GUARD` provider first (`guard.ts`).
 */
@Controller("api/v1")
@UseGuards(QueryGuardGate)
@UseFilters(QueryExceptionFilter)
export class QueryController {
  constructor(
    private readonly query: QueryService,
    private readonly overviewService: OverviewService,
    private readonly explainService: ExplainService,
    private readonly metricsService: MetricsService,
  ) {}

  @Inject(LogSearchService)
  private readonly logSearch!: LogSearchService;

  @Inject(TraceLogsService)
  private readonly traceLogsService!: TraceLogsService;

  @Inject(SERVER_CONFIG)
  private readonly config!: ServerConfig;

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
    const v = parse(req, traceTimelineSpec);
    return this.query.timeline(v, requestWindow(this.config, v));
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

  /** Issue #17, D-106: search over the stored log lines. */
  @Get("logs")
  @Headers()
  logs(@Req() req: RequestLike) {
    return this.logSearch.search(parse(req, logSearchSpec));
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
    const w = requestWindow(this.config, v);
    return this.query.errorGroups(
      w.windowMinutes,
      scopeOf(v),
      w.now,
      v.triage as TriageFilter,
    );
  }

  @Get("errors/insights")
  @Headers()
  errorInsights(@Req() req: RequestLike) {
    const v = parse(req, errorInsightsSpec);
    return this.query.errorInsights(v.route as string | undefined, scopeOf(v));
  }

  @Get("routes")
  @Headers()
  routes(@Req() req: RequestLike) {
    const v = parse(req, routeStatsSpec);
    const w = requestWindow(this.config, v);
    return this.query.routes(w.windowMinutes, scopeOf(v), w.now);
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
    const w = requestWindow(this.config, v);
    return this.query.routeHistogram(
      v.route,
      typeof v.method === "string" ? v.method.toUpperCase() : undefined,
      w.windowMinutes,
      scopeOf(v),
      w.now,
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
    const scope = scopeOf(v);
    if (typeof a === "string" && typeof b === "string") {
      return this.query.releaseCompare(a, b, scope);
    }
    const w = requestWindow(this.config, v);
    return this.query.windowCompare(w.windowMinutes, scope, w.now);
  }

  @Get("routes/explain")
  @Headers()
  routeExplain(@Req() req: RequestLike) {
    const v = parse(req, routeExplainSpec);
    const bad = (message: string): never => {
      const body: ApiError = { error: { code: "bad_request", message } };
      throw new HttpException(body, 400);
    };
    if (typeof v.route !== "string") {
      bad('Query parameter "route" is required.');
    }
    if ((v.releaseA === undefined) !== (v.releaseB === undefined)) {
      bad('Query parameters "releaseA" and "releaseB" must be given together.');
    }
    const w = requestWindow(this.config, v, 60);
    return this.explainService.explain(
      {
        method: v.method as string | undefined,
        route: v.route as string,
        windowMinutes: w.windowMinutes,
        releaseA: v.releaseA as string | undefined,
        releaseB: v.releaseB as string | undefined,
        scope: scopeOf(v),
      },
      w.now,
    );
  }

  @Get("overview")
  @Headers()
  overview(@Req() req: RequestLike) {
    const v = parse(req, overviewSpec);
    const w = requestWindow(this.config, v);
    return this.overviewService.overview(
      w.windowMinutes,
      v.apdexMs as number,
      scopeOf(v),
      w.now,
    );
  }

  @Get("classes")
  @Headers()
  classes(@Req() req: RequestLike) {
    const v = parse(req, classStatsSpec);
    const w = requestWindow(this.config, v);
    return this.query.classesWithPrevious(w.windowMinutes, scopeOf(v), w.now);
  }

  @Get("queries")
  @Headers()
  queries(@Req() req: RequestLike) {
    const v = parse(req, queryStatsSpec);
    const w = requestWindow(this.config, v);
    return this.query.queries(
      w.windowMinutes,
      scopeOf(v),
      (v.sort as QuerySort | undefined) ?? "total",
      v.limit as number,
      w.now,
    );
  }

  @Get("map")
  @Headers()
  map(@Req() req: RequestLike) {
    const v = parse(req, appMapSpec);
    const w = requestWindow(this.config, v);
    return this.query.mapWithPrevious(w.windowMinutes, scopeOf(v), w.now);
  }

  @Get("dependencies")
  @Headers()
  dependencies(@Req() req: RequestLike) {
    const v = parse(req, dependencySpec);
    const w = requestWindow(this.config, v);
    return this.query.dependenciesWithPrevious(
      w.windowMinutes,
      scopeOf(v),
      w.now,
    );
  }

  /** Issue #18 (D-105): stored metrics, their units and what was seen; `404` unless `NESTRIX_METRICS=on`. */
  @Get("metrics/catalog")
  @Headers()
  async metricCatalog(@Req() req: RequestLike) {
    const v = parse(req, metricCatalogSpec);
    requireMetrics(this.metricsService);
    return metricsCall(() =>
      this.metricsService.catalog({
        service: v.service as string | undefined,
        environment: v.environment as string | undefined,
        fromUnixMs: v.fromUnixMs as number | undefined,
        toUnixMs: v.toUnixMs as number | undefined,
      }),
    );
  }

  /** Issue #18 (D-105): one metric over time; see `@nestrix-js/protocol` `metrics.ts`. */
  @Get("metrics/series")
  @Headers()
  async metricSeries(@Req() req: RequestLike) {
    const v = parse(req, metricSeriesSpec);
    requireMetrics(this.metricsService);
    if (typeof v.metric !== "string") {
      const body: ApiError = {
        error: {
          code: "bad_request",
          message: 'Query parameter "metric" is required.',
        },
      };
      throw new HttpException(body, 400);
    }
    return metricsCall(() =>
      this.metricsService.series({
        metric: v.metric as string,
        service: v.service as string | undefined,
        environment: v.environment as string | undefined,
        instance: v.instance as string | undefined,
        fromUnixMs: v.fromUnixMs as number | undefined,
        toUnixMs: v.toUnixMs as number | undefined,
        stepMs: v.stepMs as number | undefined,
        aggregation: v.aggregation as MetricAggregation | undefined,
        by: v.by as "instance" | undefined,
      }),
    );
  }
}

function requireMetrics(service: MetricsService): void {
  if (!service.enabled) {
    throw new HttpException("Historical metrics are not enabled.", 404);
  }
}

async function metricsCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MetricsParamError) {
      const body: ApiError = {
        error: { code: "bad_request", message: error.message },
      };
      throw new HttpException(body, 400);
    }
    throw error;
  }
}
