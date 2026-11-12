/**
 * The embedded dashboard inside the host application (architecture §4.6, §4.7; D-45, D-46;
 * backlog P2-06).
 *
 * Lifecycle, driven by `NestrixCore`:
 * 1. Constructor (`createDashboard`): the mode is already resolved (module factory). When it is on
 *    and `@nestrix-js/ui` can be located, a `Dashboard` is created. Its `hookConfig` (dashboard path,
 *    route statistics, shadowing callback) goes to the request hook and the store limits to the
 *    telemetry setup, both at construction (an SDK 3 provider takes processors only in its
 *    constructor). Nothing is registered yet.
 * 2. `onModuleInit` (`mount`): with no HTTP adapter, nothing is registered and the store is
 *    detached. Otherwise `@nestrix-js/ui`'s files are read into memory, the startup token is created
 *    (`'auto'` mode), and every route is registered with `httpAdapter.get` (D-45).
 * 3. `HttpAdapterHost.listen$`: one log line with the real port and, in `'auto'` mode, the
 *    startup-token link. If the app has not listened shortly after init, a line without the token
 *    says the link needs a listening server.
 *
 * Every handler: marks the request reached (shadowing check), hijacks on Fastify, takes the raw
 * response, strips `Access-Control-*`, decides access (raced against a timeout that denies),
 * writes status, headers and body to the raw response, and answers its own `500` on any failure.
 * Nothing escapes a handler to the host's exception filters (P0-S5 Q2), and no handler returns a
 * promise to the adapter.
 */
import { randomBytes } from "node:crypto";
import type { MetaResponse, RuntimeSample } from "@nestrix-js/protocol";
import type { Diagnostics } from "../diagnostics.js";
import { markDashboardHandlerReached } from "../http/request-state.js";
import type { AdapterHostLike, DashboardHookConfig } from "../http/server.js";
import { setMethodCallSink } from "../methods/sink.js";
import type { TelemetryHandle } from "../otel/types.js";
import { getProfiler } from "../profiler/profiler.js";
import type {
  ResolvedOptions,
  ResolvedUiAuto,
  ResolvedUiEnabled,
} from "../resolve-options.js";
import { ClassStatistics } from "../stats/class-stats.js";
import { RouteStatistics } from "../stats/route-stats.js";
import {
  type AccessDecision,
  checkAccess,
  DENY,
  decideTokenExchange,
  type ExchangeDecision,
  rawRequestOf,
} from "./access.js";
import {
  type ApiSources,
  apiError,
  classesHandler,
  dependenciesHandler,
  errorGroupsHandler,
  errorsHandler,
  mapHandler,
  metaHandler,
  overviewHandler,
  PROTOCOL_VERSION,
  parseQuery,
  queriesHandler,
  routeCompareHandler,
  routeExplainHandler,
  routeHistogramHandler,
  routesHandler,
  timelineHandler,
  traceHandler,
  traceLogsHandler,
  tracesHandler,
} from "./api.js";
import { loadUi, renderIndex, type UiBundle, uiPackage } from "./assets.js";
import {
  checkStartHeaders,
  listProfiles,
  parseStartBody,
  profileDetail,
  profileDownload,
  readStartBody,
  startCapture,
} from "./profiles.js";
import {
  type DashboardResponse,
  HTML_TYPE,
  IMMUTABLE,
  type RawResponseLike,
  rawResponseOf,
  stripCors,
  takeOver,
  writeFailure,
  writeResponse,
} from "./respond.js";
import { RuntimeSampler, runtimeHandler } from "./runtime.js";
import {
  dashboardLinkLine,
  getProcessStartupToken,
  type StartupTokenSecret,
} from "./startup-token.js";

/** Timings. Internal; tests shorten them. */
export const dashboardTimings = {
  /** An access check (an `authorize` that never settles) is denied after this long. */
  accessTimeoutMs: 10_000,
  /** Without `listen$` this long after `onModuleInit`, the line without the token link is logged. */
  listenGraceMs: 2_000,
};

/** Nest's `Logger`, as far as Nestrix uses it. */
export interface DashboardLogger {
  log(message: string): unknown;
  error(message: string): unknown;
}

export type ActiveUi = ResolvedUiAuto | ResolvedUiEnabled;

/**
 * Internal fault-injection seam for tests (the "handler fault answers 500" check). Not exported
 * from `src/index.ts` and not public API. `handler` throws inside a handler after the response
 * was taken over; `handler-sync` throws before the access check is started.
 */
export const dashboardFaults: { site: "handler" | "handler-sync" | undefined } =
  { site: undefined };

function maybeFault(site: "handler" | "handler-sync"): void {
  if (dashboardFaults.site === site) {
    throw new Error(`Nestrix injected fault at dashboard ${site}`);
  }
}

const DENIED: DashboardResponse = Object.freeze({
  status: 404,
  minimal: true,
});

/** The `403` page of `'auto'` mode without the startup cookie. Static: no script, no inline style. */
export const NEED_TOKEN_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nestrix dashboard</title>
  </head>
  <body>
    <h1>Open the dashboard from the startup link</h1>
    <p>This dashboard only opens from the link Nestrix wrote to the application's log when it started, a line beginning with <code>Nestrix dashboard: http://localhost:</code> and ending in <code>/auth?token=&hellip;</code>.</p>
    <p>Open that link in this browser. If the application restarted, open the new link: each start creates a new token.</p>
  </body>
</html>
`;

const NEED_TOKEN_MESSAGE =
  "Open the dashboard link Nestrix logged at startup (it ends in /auth?token=...) in this browser first.";
const INTERNAL_MESSAGE = "The dashboard could not answer this request.";

type RouteKind = "page" | "api";

function needToken(kind: RouteKind): DashboardResponse {
  return kind === "api"
    ? apiError(403, "forbidden", NEED_TOKEN_MESSAGE)
    : { status: 403, contentType: HTML_TYPE, body: NEED_TOKEN_PAGE };
}

function internalError(kind: RouteKind): DashboardResponse {
  return kind === "api"
    ? apiError(500, "internal", INTERNAL_MESSAGE)
    : { status: 500 };
}

/** Resolves with `fallback` after `ms` unless `work` settles first. Never rejects. */
function raceTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([work.catch(() => fallback), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The parts of an HTTP adapter the dashboard calls. */
interface RoutableAdapter {
  get(path: string, handler: (req: unknown, res: unknown) => void): unknown;
  /** The profiler's start route only (P7-02). */
  post?(path: string, handler: (req: unknown, res: unknown) => void): unknown;
  getHttpServer?(): unknown;
}

function isRoutable(adapter: unknown): adapter is RoutableAdapter {
  return (
    adapter !== null &&
    typeof adapter === "object" &&
    typeof (adapter as RoutableAdapter).get === "function"
  );
}

function listeningPort(adapter: RoutableAdapter): number | undefined {
  try {
    const server = adapter.getHttpServer?.() as
      | { address?: () => unknown }
      | undefined;
    const address = server?.address?.();
    if (address !== null && typeof address === "object") {
      const port = (address as { port?: unknown }).port;
      if (typeof port === "number") return port;
    }
  } catch {
    // No port to report.
  }
  return undefined;
}

function stringAttribute(
  attributes: Readonly<Record<string, unknown>>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * `meta.service`. The version is the resolved `service.version` (D-63) when Nestrix owns the
 * provider, because only then is it on the traces' resource; a host-owned resource is not
 * readable here, so the version is left out (each trace still carries its own `release`).
 */
function serviceOf(
  options: ResolvedOptions,
  ownsProvider: boolean,
): MetaResponse["service"] {
  const attrs = options.resourceAttributes;
  const service: MetaResponse["service"] = {};
  const name = options.serviceName ?? stringAttribute(attrs, "service.name");
  if (name !== undefined) service.name = name;
  const version = ownsProvider ? options.serviceVersion : undefined;
  if (version !== undefined) service.version = version;
  const environment = stringAttribute(
    attrs,
    "deployment.environment.name",
    "deployment.environment",
  );
  if (environment !== undefined) service.environment = environment;
  return service;
}

export class Dashboard {
  /** Route statistics; recorded by the request hook, read by the routes endpoint. */
  readonly stats = new RouteStatistics();
  /** Class statistics; the method call sink while the dashboard is mounted. */
  readonly classStats = new ClassStatistics();
  private removeSink: (() => void) | undefined;
  /** For `installHttpInstrumentation`, at construction. */
  readonly hookConfig: DashboardHookConfig;
  private sources: ApiSources | undefined;
  private startup: StartupTokenSecret | undefined;
  private linkLogged = false;
  private listenSubscription: { unsubscribe(): void } | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** The profiler routes are registered (P7-02): `ui.profiler` resolved true and `post` exists. */
  private profilerOn = false;
  /** The runtime view's sampler (P9-06), running from mount to dispose. */
  private readonly runtime: RuntimeSampler;

  constructor(
    readonly ui: ActiveUi,
    private readonly uiDirectory: string,
    private readonly options: ResolvedOptions,
    private readonly diagnostics: Diagnostics,
    private readonly logger: DashboardLogger,
  ) {
    this.runtime = new RuntimeSampler(diagnostics);
    const path = ui.path;
    this.hookConfig = {
      dashboardPath: path,
      stats: this.stats,
      onShadowed: (status) => this.reportShadowed(status),
    };
  }

  /** The shadowing log line, once per process per kind (backlog P2, "Public API"). Never throws. */
  private reportShadowed(status: number): void {
    const path = this.ui.path;
    if (status === 401 || status === 403 || status === 429) {
      this.diagnostics.logOnce(
        "dashboard.host-middleware",
        `Nestrix dashboard: a request under ${path} was answered by host middleware before the dashboard (status ${status}). Host middleware such as an auth gate or a rate limiter also applies to the dashboard's routes; let requests under ${path} through to use the dashboard.`,
      );
    } else {
      this.diagnostics.logOnce(
        "dashboard.shadowed",
        `Nestrix dashboard: ${path} is shadowed by a host route (a catch-all, or @nestjs/serve-static's fallback): a request under it was answered with status ${status} without reaching the dashboard. Exclude ${path} from that route (for @nestjs/serve-static, its exclude option) or set ui.path to another path.`,
      );
    }
  }

  /**
   * `onModuleInit`. Registers the routes on the HTTP adapter, or, without one, registers nothing
   * and detaches the store. Never throws.
   */
  mount(
    adapterHost: AdapterHostLike | undefined,
    telemetry: TelemetryHandle | undefined,
  ): void {
    try {
      const adapter = adapterHost?.httpAdapter;
      if (!isRoutable(adapter)) {
        // createMicroservice, createApplicationContext, TestingModule.init(): off, silently.
        telemetry?.detachStore?.();
        return;
      }
      let bundle: UiBundle;
      try {
        bundle = loadUi(this.uiDirectory);
      } catch (error) {
        telemetry?.detachStore?.();
        this.logger.error(
          `Nestrix dashboard: off. @nestrix-js/ui could not be loaded (${error instanceof Error ? error.message : "unknown error"}); reinstall it, at the same version as @nestrix-js/nestjs. The application starts without the dashboard.`,
        );
        return;
      }
      if (this.ui.mode === "auto" && this.ui.startupToken) {
        this.startup = getProcessStartupToken();
      }
      const store = telemetry?.store;
      this.sources = {
        store,
        stats: this.stats,
        classes: this.classStats,
        service: serviceOf(this.options, telemetry?.ownsProvider === true),
        sampling:
          telemetry?.ownsProvider === true
            ? { owner: "nestrix", rate: this.options.sampleRate }
            : { owner: "host", rate: null },
        hostOwnsProvider: telemetry?.ownsProvider !== true,
        ignoresRoutes: this.options.ignore.paths.length > 0,
        fallbackProcessId: randomBytes(8).toString("hex"),
        profiler: () => getProfiler().meta(this.profilerOn),
      };
      this.register(adapter, bundle);
      this.removeSink = setMethodCallSink(this.classStats);
      this.runtime.start();
      this.watchListen(adapterHost, adapter);
    } catch (error) {
      this.diagnostics.countFailure("dashboard.mount", error);
    }
  }

  /**
   * The runtime sampler's newest sample while it runs (mounted, not disposed); `null` otherwise.
   * For the remote-profiling check-in (P15-03). Never throws.
   */
  latestRuntimeSample(): RuntimeSample | null {
    try {
      return this.runtime.latest();
    } catch (error) {
      this.diagnostics.countFailure("dashboard.runtime.latest", error);
      return null;
    }
  }

  /** `onApplicationShutdown`. Never throws. */
  dispose(): void {
    this.disposed = true;
    try {
      // A capture this app started is discarded, not kept (D-70).
      getProfiler().discard(this);
    } catch (error) {
      this.diagnostics.countFailure("dashboard.dispose", error);
    }
    try {
      this.runtime.stop();
    } catch (error) {
      this.diagnostics.countFailure("dashboard.dispose", error);
    }
    try {
      this.removeSink?.();
    } catch (error) {
      this.diagnostics.countFailure("dashboard.dispose", error);
    }
    this.removeSink = undefined;
    try {
      this.listenSubscription?.unsubscribe();
    } catch (error) {
      this.diagnostics.countFailure("dashboard.dispose", error);
    }
    this.listenSubscription = undefined;
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
  }

  private register(adapter: RoutableAdapter, bundle: UiBundle): void {
    const path = this.ui.path;
    const index = Buffer.from(
      renderIndex(bundle.indexTemplate, {
        apiBase: `${path}/api/v1`,
        path,
        protocolVersion: PROTOCOL_VERSION,
      }),
      "utf8",
    );
    const indexResponse: DashboardResponse = {
      status: 200,
      contentType: HTML_TYPE,
      body: index,
    };
    const routes: Array<[string, (req: unknown, res: unknown) => void]> = [];
    const page = this.handler("page", () => indexResponse);
    routes.push([path, page], [`${path}/`, page]);
    routes.push([`${path}/auth`, this.exchangeHandler()]);
    for (const [file, asset] of bundle.assets) {
      const response: DashboardResponse = {
        status: 200,
        contentType: asset.contentType,
        cacheControl: IMMUTABLE,
        body: asset.body,
      };
      routes.push([`${path}/${file}`, this.handler("page", () => response)]);
    }
    const api = `${path}/api/v1`;
    const sources = (): ApiSources => this.sources as ApiSources;
    routes.push(
      [`${api}/meta`, this.handler("api", (t) => metaHandler(t, sources()))],
      [
        `${api}/traces`,
        this.handler("api", (t) => tracesHandler(t, sources())),
      ],
      [`${api}/trace`, this.handler("api", (t) => traceHandler(t, sources()))],
      [
        `${api}/trace/logs`,
        this.handler("api", (t) => traceLogsHandler(t, sources())),
      ],
      [
        `${api}/errors`,
        this.handler("api", (t) => errorsHandler(t, sources())),
      ],
      [
        `${api}/errors/groups`,
        this.handler("api", (t) => errorGroupsHandler(t, sources())),
      ],
      [
        `${api}/routes`,
        this.handler("api", (t) => routesHandler(t, sources())),
      ],
      [
        `${api}/routes/histogram`,
        this.handler("api", (t) => routeHistogramHandler(t, sources())),
      ],
      [
        `${api}/routes/compare`,
        this.handler("api", (t) => routeCompareHandler(t, sources())),
      ],
      [
        `${api}/routes/explain`,
        this.handler("api", (t) => routeExplainHandler(t, sources())),
      ],
      [
        `${api}/classes`,
        this.handler("api", (t) => classesHandler(t, sources())),
      ],
      [`${api}/map`, this.handler("api", (t) => mapHandler(t, sources()))],
      [
        `${api}/queries`,
        this.handler("api", (t) => queriesHandler(t, sources())),
      ],
      [
        `${api}/runtime`,
        this.handler("api", (t) => runtimeHandler(t, this.runtime)),
      ],
      [
        `${api}/dependencies`,
        this.handler("api", (t) => dependenciesHandler(t, sources())),
      ],
      [
        `${api}/overview`,
        this.handler("api", (t) => overviewHandler(t, sources())),
      ],
      [
        `${api}/traces/timeline`,
        this.handler("api", (t) => timelineHandler(t, sources())),
      ],
    );
    // The profiler (P7-02): registered only where it is offered, so `ui.profiler: false` or an
    // unauthenticated dashboard has no such route at all.
    const profilerRoutes =
      this.ui.profiler && typeof adapter.post === "function";
    if (profilerRoutes) {
      const profiler = getProfiler();
      routes.push(
        [
          `${api}/profiles`,
          this.handler("api", (t) => listProfiles(t, profiler)),
        ],
        [
          `${api}/profiles/:id`,
          this.handler("api", (t) => profileDetail(t, profiler)),
        ],
        [
          `${api}/profiles/:id/download`,
          this.handler("api", (t) => profileDownload(t, profiler)),
        ],
      );
    }
    for (const [route, handler] of routes) {
      try {
        adapter.get(route, handler);
      } catch (error) {
        // A host router that refuses one path (Fastify `ignoreTrailingSlash` makes `<path>` and
        // `<path>/` one route) must not cost the others.
        this.diagnostics.countFailure("dashboard.register", error);
      }
    }
    if (profilerRoutes) {
      try {
        adapter.post?.(`${api}/profiles`, this.startHandler());
        this.profilerOn = true;
      } catch (error) {
        this.diagnostics.countFailure("dashboard.register", error);
      }
    }
  }

  /**
   * `POST <path>/api/v1/profiles` (P7-02): read access first, as every route (a refusal there is
   * the bare 404 or the 403 page, revealing nothing), then the write rules of `profiles.ts`, then
   * the capture. Synchronous, returns nothing, never throws.
   */
  private startHandler(): (req: unknown, res: unknown) => void {
    return (req, res) =>
      this.run(req, res, "api", async (request) => {
        const decision = await this.decide(request);
        if (decision.outcome === "deny") return DENIED;
        if (decision.outcome === "need-token") return needToken("api");
        maybeFault("handler");
        const raw = rawRequestOf(request);
        const query = parseQuery(raw?.url, {});
        if (!query.ok) return apiError(400, "bad_request", query.message);
        const refused = checkStartHeaders(raw);
        if (refused !== undefined) return refused;
        const body = await readStartBody(request, raw);
        if (!body.ok) return body.response;
        const parsed = parseStartBody(body.value);
        if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
        return startCapture(getProfiler(), this, parsed.durationSeconds);
      });
  }

  private decide(request: unknown): Promise<AccessDecision> {
    return raceTimeout(
      checkAccess(request, this.ui, this.startup),
      dashboardTimings.accessTimeoutMs,
      DENY,
    );
  }

  /** A route handler: synchronous, returns nothing, never throws. */
  private handler(
    kind: RouteKind,
    answer: (target: unknown) => DashboardResponse,
  ): (req: unknown, res: unknown) => void {
    return (req, res) =>
      this.run(req, res, kind, async (request) => {
        const decision = await this.decide(request);
        if (decision.outcome === "deny") return DENIED;
        if (decision.outcome === "need-token") return needToken(kind);
        maybeFault("handler");
        return answer(rawRequestOf(request)?.url);
      });
  }

  /** `GET <path>/auth?token=`: the token exchange (D-46). */
  private exchangeHandler(): (req: unknown, res: unknown) => void {
    return (req, res) =>
      this.run(req, res, "page", async (request) => {
        const decision = await raceTimeout<ExchangeDecision>(
          decideTokenExchange(request, this.ui, this.startup),
          dashboardTimings.accessTimeoutMs,
          DENY,
        );
        if (decision.outcome === "deny") return DENIED;
        if (decision.outcome === "need-token") return needToken("page");
        maybeFault("handler");
        const headers: Record<string, string> = {
          location: decision.location,
        };
        if (decision.setCookie !== undefined) {
          headers["set-cookie"] = decision.setCookie;
        }
        return { status: 303, headers };
      });
  }

  private run(
    req: unknown,
    res: unknown,
    kind: RouteKind,
    work: (request: unknown) => Promise<DashboardResponse>,
  ): void {
    // First, before anything that can fail: a handler ran, so this is not shadowing.
    markDashboardHandlerReached(req);
    let raw: RawResponseLike | undefined;
    const fail = (error: unknown): void => {
      this.diagnostics.countFailure("dashboard.handler", error);
      writeFailure(raw, internalError(kind));
    };
    try {
      takeOver(res);
      raw = rawResponseOf(res);
      if (raw === undefined) throw new Error("no raw response to write");
      // Before any work, so the error path carries no allow headers either.
      stripCors(raw);
      maybeFault("handler-sync");
      const target = raw;
      work(req).then((response) => {
        try {
          writeResponse(target, response);
        } catch (error) {
          fail(error);
        }
      }, fail);
    } catch (error) {
      fail(error);
    }
  }

  private watchListen(
    adapterHost: AdapterHostLike | undefined,
    adapter: RoutableAdapter,
  ): void {
    const logLink = (port: number | undefined, final = true): void => {
      try {
        if (this.linkLogged || this.disposed) return;
        if (final) this.linkLogged = true;
        this.logger.log(
          dashboardLinkLine({
            path: this.ui.path,
            port,
            startupToken: this.startup?.token,
          }),
        );
      } catch (error) {
        this.diagnostics.countFailure("dashboard.link", error);
      }
    };
    const host = adapterHost as
      | (AdapterHostLike & { listen$?: unknown; listening?: unknown })
      | undefined;
    if (host?.listening === true) {
      logLink(listeningPort(adapter));
      return;
    }
    const listen$ = host?.listen$ as
      | {
          subscribe?: (observer: { next: () => void; error: () => void }) => {
            unsubscribe(): void;
          };
        }
      | undefined;
    if (listen$ && typeof listen$.subscribe === "function") {
      // Runs inside Nest's listen callback: guarded (logLink catches everything).
      this.listenSubscription = listen$.subscribe({
        next: () => logLink(listeningPort(adapter)),
        error: () => undefined,
      });
    }
    // Never listening (`app.init()` only, `inject()`, serverless): say where it is served.
    this.graceTimer = setTimeout(() => {
      try {
        // No port, so no token in the line; not marked logged, so `listen$` can still log the link.
        if (host?.listening !== true) logLink(undefined, false);
      } catch (error) {
        this.diagnostics.countFailure("dashboard.link", error);
      }
    }, dashboardTimings.listenGraceMs);
    this.graceTimer.unref?.();
  }
}

/**
 * Why the dashboard is off although its options allowed it, decided in the constructor; logged
 * at `onModuleInit` when there is an HTTP adapter.
 */
export type DashboardUnavailable = "ui-missing";

/**
 * At the `NestrixCore` constructor: a `Dashboard` when the resolved mode is on and `@nestrix-js/ui`
 * can be located; otherwise why not (`undefined` reason when the mode itself is off). Never throws.
 */
export function createDashboard(
  options: ResolvedOptions,
  diagnostics: Diagnostics,
  logger: DashboardLogger,
):
  | { dashboard: Dashboard }
  | { unavailable: DashboardUnavailable | undefined } {
  try {
    const ui = options.ui;
    if (ui.mode === "off") return { unavailable: undefined };
    const directory = uiPackage.resolveDirectory();
    if (directory === undefined) return { unavailable: "ui-missing" };
    return {
      dashboard: new Dashboard(ui, directory, options, diagnostics, logger),
    };
  } catch (error) {
    diagnostics.countFailure("dashboard.create", error);
    return { unavailable: undefined };
  }
}

export const UI_MISSING_MESSAGE =
  "Nestrix dashboard: off, because @nestrix-js/ui is not installed. Install it at the same version as @nestrix-js/nestjs to serve the dashboard: npm install @nestrix-js/ui";
