import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from "@nestjs/common";
import { HttpAdapterHost, ModulesContainer } from "@nestjs/core";
import {
  createDashboard,
  type Dashboard,
  type DashboardLogger,
  type DashboardUnavailable,
  UI_MISSING_MESSAGE,
} from "./dashboard/mount.js";
import { diagnostics } from "./diagnostics.js";
import { NestrixInterceptor } from "./http/interceptor.js";
import { installHttpInstrumentation } from "./http/server.js";
import {
  installIntegrations,
  rescanIntegrations,
} from "./integrations/index.js";
import { type LogExportHandle, setupLogExport } from "./logs/export.js";
import { configureMethods, markNestrixInternal } from "./methods/registry.js";
import { type NestrixMetrics, startMetrics } from "./metrics/index.js";
import { instanceIdentity } from "./otel/resource.js";
import { setupTelemetry } from "./otel/setup.js";
import type { TelemetryHandle } from "./otel/types.js";
import { installOutbound } from "./outbound/index.js";
import { buildRedactedQueryKeys, scrubSpanAttributes } from "./privacy.js";
import { installProcessErrorMonitor } from "./process-errors.js";
import { RemoteProfilerPoller } from "./profiler/remote.js";
import type { ResolvedOptions } from "./resolve-options.js";
import { NESTRIX_OPTIONS } from "./tokens.js";

/**
 * The module's one eagerly constructed provider. Later tasks hook in from its constructor,
 * which runs during `NestFactory.create` (provider construction), never at import or
 * `forRoot()` time (architecture §4.2 "Registration timing").
 *
 * The constructor catches everything (rule 1): a Nestrix fault must not stop the host booting.
 * Option validation is not here; it already happened in the module factory.
 */
@Injectable()
export class NestrixCore
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  /** Undefined when disabled or when setup failed. */
  readonly telemetry: TelemetryHandle | undefined;
  /** P6-02. Undefined with `metrics: false`, when disabled, or when setup failed. */
  readonly metrics: NestrixMetrics | undefined;
  private readonly disposers: Array<() => void> = [];
  /** Set when the dashboard's mode is on and `@nestrix-js/ui` was located (P2-06). */
  private readonly dashboard: Dashboard | undefined;
  /** Why the dashboard is off although its mode allowed it; logged at `onModuleInit`. */
  private readonly dashboardUnavailable: DashboardUnavailable | undefined;
  private readonly adapterHost: HttpAdapterHost | undefined;
  /** Set when `logs.export` is on (P6-01). */
  private readonly logExport: LogExportHandle | undefined;
  /** P10-01: set with `export.profiler: true` and a base endpoint; started at bootstrap. */
  private readonly remoteProfiler: RemoteProfilerPoller | undefined;
  private readonly logger: DashboardLogger;

  constructor(
    @Inject(NESTRIX_OPTIONS) readonly options: ResolvedOptions,
    // Explicit token, so injection does not depend on `design:paramtypes` being emitted.
    @Optional() @Inject(HttpAdapterHost) adapterHost?: HttpAdapterHost,
    // Level 2 (P3-02): the scanned modules, read once here to compute the own set (D-58).
    @Optional() @Inject(ModulesContainer) modules?: ModulesContainer,
  ) {
    this.adapterHost = adapterHost;
    this.logger = new Logger("Nestrix");
    let telemetry: TelemetryHandle | undefined;
    let logExport: LogExportHandle | undefined;
    let dashboard: Dashboard | undefined;
    let unavailable: DashboardUnavailable | undefined;
    let metrics: NestrixMetrics | undefined;
    try {
      if (options.enabled) {
        // The mode is resolved already (module factory). Wired now, because an SDK 3 provider
        // takes its processors only in its constructor; routes come at `onModuleInit` (D-45).
        const created = createDashboard(options, diagnostics, this.logger);
        if ("dashboard" in created) dashboard = created.dashboard;
        else unavailable = created.unavailable;
        const queryKeys = buildRedactedQueryKeys(options.http.redactQueryKeys);
        telemetry = setupTelemetry(
          {
            ...options,
            scrub: (span) => scrubSpanAttributes(span, queryKeys),
            dashboardStore: dashboard ? options.store : undefined,
            dashboardLogs: options.ui.mode !== "off" && options.ui.logs,
          },
          diagnostics,
        );
        // One rule for every signal: the host's SDK owns logs and metrics too (D-69).
        if (options.logs.export && telemetry?.ownsProvider !== true) {
          diagnostics.logOnce(
            "logs.host-sdk",
            "Log export is on but Nestrix does not own the OpenTelemetry provider (your app's SDK does, or trace export is off), so Nestrix registers no LoggerProvider. Export logs through your own SDK; NestrixLogger records still reach it.",
          );
        } else {
          logExport = setupLogExport(options, diagnostics);
        }
        // P6-02: after the telemetry setup, which decides whether Nestrix may export metrics.
        metrics = startMetrics(options, telemetry, diagnostics);
        // Outbound subscribers work with or without an HTTP adapter, and with a host-owned SDK.
        this.disposers.push(installOutbound(options, diagnostics));
        // Level 3 (P3-01): pg wrapped now, and again at onApplicationBootstrap (D-50).
        this.disposers.push(installIntegrations(options, diagnostics));
        // HTTP hooks now, or from `init$` under @nestjs/testing; nothing without an adapter.
        this.disposers.push(
          installHttpInstrumentation(
            adapterHost,
            options,
            diagnostics,
            dashboard?.hookConfig,
            metrics?.http,
          ),
          installProcessErrorMonitor(),
        );
      }
    } catch (error) {
      diagnostics.countFailure("core.constructor", error);
    }
    try {
      // Level 2 (P3-02): switch the method wrappers' plans now that Nest's module scan is done.
      // Inert without `NestrixInstrument`; `configureMethods` never throws.
      if (options.enabled) {
        this.disposers.push(
          configureMethods(options.methods, modules?.values()),
        );
      }
    } catch (error) {
      diagnostics.countFailure("core.methods", error);
    }
    let remoteProfiler: RemoteProfilerPoller | undefined;
    try {
      // P10-01 (D-76): built now, started at `onApplicationBootstrap`. Independent of the
      // dashboard and of who owns the trace provider.
      const remote = options.enabled ? options.export.profiler : false;
      if (remote !== false) {
        if (remote.target === undefined) {
          diagnostics.logOnce(
            "profiler.remote-no-endpoint",
            "export.profiler is on, but no export endpoint is set (export.otlp.endpoint or OTEL_EXPORTER_OTLP_ENDPOINT; a traces URL alone is not enough), or export.otlp is false. Remote profiling is off.",
          );
        } else {
          const logger = this.logger;
          const board = dashboard;
          remoteProfiler = new RemoteProfilerPoller({
            target: remote.target,
            identity: instanceIdentity(options, telemetry),
            diagnostics,
            log: (message) => logger.log(message),
            // P15-03: the check-in's event-loop p99 comes from the dashboard's sampler, if any.
            latestRuntimeSample:
              board === undefined
                ? undefined
                : () => board.latestRuntimeSample(),
          });
        }
      }
    } catch (error) {
      diagnostics.countFailure("core.remote-profiler", error);
    }
    this.remoteProfiler = remoteProfiler;
    this.telemetry = telemetry;
    this.logExport = logExport;
    this.metrics = metrics;
    this.dashboard = dashboard;
    this.dashboardUnavailable = unavailable;
  }

  /**
   * Mounts the dashboard (D-45), or logs once why it is off (backlog P2, "Mode resolution"):
   * an off mode at its severity (an `info` reason only when there is an HTTP adapter, so a
   * microservice says nothing), `@nestrix-js/ui` missing with the install command. No HTTP adapter:
   * nothing registered, store detached. Never throws.
   */
  onModuleInit(): void {
    try {
      if (!this.options.enabled) return;
      if (this.dashboard) {
        this.dashboard.mount(this.adapterHost, this.telemetry);
        return;
      }
      const hasAdapter = Boolean(this.adapterHost?.httpAdapter);
      const ui = this.options.ui;
      if (ui.mode === "off") {
        if (ui.severity === "error") this.logger.error(ui.message);
        else if (hasAdapter) this.logger.log(ui.message);
      } else if (this.dashboardUnavailable === "ui-missing" && hasAdapter) {
        this.logger.log(UI_MISSING_MESSAGE);
      }
    } catch (error) {
      diagnostics.countFailure("core.module-init", error);
    }
  }

  /** Wraps `pg` copies loaded while the app was built (D-50). Never throws. */
  onApplicationBootstrap(): void {
    try {
      if (this.options.enabled) rescanIntegrations();
    } catch (error) {
      diagnostics.countFailure("core.bootstrap", error);
    }
    // After every host `onModuleInit`, so a MeterProvider the host registers there is found by
    // the silent probe and Nestrix does not claim the global slot first (P6-02).
    try {
      this.metrics?.startExport();
    } catch (error) {
      diagnostics.countFailure("core.bootstrap", error);
    }
    // P10-01: the first check-in is a few seconds from now, never inside bootstrap.
    try {
      this.remoteProfiler?.start();
    } catch (error) {
      diagnostics.countFailure("core.bootstrap", error);
    }
  }

  /** Runs on `app.close()`; on SIGTERM/SIGINT only with `app.enableShutdownHooks()`. Never rejects. */
  async onApplicationShutdown(): Promise<void> {
    // First: no check-in or upload may start while the rest shuts down.
    try {
      this.remoteProfiler?.stop();
    } catch (error) {
      diagnostics.countFailure("core.shutdown", error);
    }
    try {
      this.dashboard?.dispose();
    } catch (error) {
      diagnostics.countFailure("core.shutdown", error);
    }
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        diagnostics.countFailure("core.shutdown", error);
      }
    }
    try {
      await this.logExport?.shutdown();
    } catch (error) {
      diagnostics.countFailure("core.shutdown", error);
    }
    try {
      // P6-02: alongside the trace flush; each is bounded and never rejects.
      await Promise.all([this.metrics?.shutdown(), this.telemetry?.shutdown()]);
    } catch (error) {
      diagnostics.countFailure("core.shutdown", error);
    }
  }
}

// Nestrix's own providers are never wrapped by level 2.
markNestrixInternal(NestrixCore, NestrixInterceptor);
