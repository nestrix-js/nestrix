/**
 * OTLP log export (D-64, D-65). The SDK packages are optional peers, loaded with a dynamic
 * `import()` only when `logs.export` is on (setup code: AGENTS.md rule 5). The logs API itself
 * (`logs`, `SeverityNumber`) is part of `@opentelemetry/api` 1.10, which is already a peer, so
 * `@opentelemetry/api-logs` is not needed.
 *
 * Ownership mirrors the tracer provider: Nestrix builds a `LoggerProvider` and registers it
 * globally; when the host already registered one, registration fails, the one built here is
 * shut down, and records go to the host's.
 */
import type { LogLevel } from "@nestjs/common";
import { context, logs, SeverityNumber } from "@opentelemetry/api";
import type {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { settle } from "../otel/redacting-exporter.js";
import { buildResource } from "../otel/resource.js";
import type { TelemetryDiagnostics } from "../otel/types.js";
import type { ResolvedOptions } from "../resolve-options.js";
import { type LogSink, setLogSink } from "./sink.js";

/** The classes taken from the optional packages. A seam so tests can make the import fail. */
export interface LogExportModules {
  LoggerProvider: typeof LoggerProvider;
  BatchLogRecordProcessor: typeof BatchLogRecordProcessor;
  OTLPLogExporter: new (config: {
    url: string;
    headers: Record<string, string>;
    timeoutMillis: number;
  }) => ConstructorParameters<typeof BatchLogRecordProcessor>[0]["exporter"];
}

export type LogExportLoader = () => Promise<LogExportModules>;

const INSTALL_COMMAND =
  "npm install @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http";

const SHUTDOWN_TIMEOUT_MILLIS = 5_000;

const loadModules: LogExportLoader = async () => {
  const [sdk, exporter] = await Promise.all([
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/exporter-logs-otlp-http"),
  ]);
  return {
    LoggerProvider: sdk.LoggerProvider,
    BatchLogRecordProcessor: sdk.BatchLogRecordProcessor,
    OTLPLogExporter: exporter.OTLPLogExporter,
  };
};

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  verbose: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  log: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export interface LogExportHandle {
  /** Flushes and, when Nestrix owns the provider, shuts it down; bounded. Never rejects. */
  shutdown(): Promise<void>;
}

interface Active {
  refs: number;
  /** Resolves when loading and registration are over, whatever the outcome. */
  ready: Promise<void>;
  provider: LoggerProvider | undefined;
  sink: LogSink | undefined;
}

let active: Active | undefined;

/** Resolves after `work` settles or `ms` pass. Never rejects. */
async function bounded(work: () => unknown, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([settle(work), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts log export when `options.logs.export` is on. Synchronous and never throws: the
 * packages load in the background, and records logged before they have loaded are printed
 * but not exported. Without an endpoint, or without the packages, one log line says so and
 * nothing else changes.
 */
export function setupLogExport(
  options: Pick<
    ResolvedOptions,
    "logs" | "serviceName" | "resourceAttributes" | "otelResourceAttributes"
  >,
  diagnostics: TelemetryDiagnostics,
  loader: LogExportLoader = loadModules,
): LogExportHandle | undefined {
  try {
    if (!options.logs.export) return undefined;
    if (active) {
      active.refs++;
      return handle(active);
    }
    const otlp = options.logs.otlp;
    if (otlp === false) {
      diagnostics.logOnce(
        "logs.no-endpoint",
        "Log export is on but there is no OTLP endpoint (export.otlp.endpoint, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT), or export.otlp is false. Logs are printed but not exported.",
      );
      return undefined;
    }
    const state: Active = {
      refs: 1,
      ready: Promise.resolve(),
      provider: undefined,
      sink: undefined,
    };
    active = state;
    state.ready = settle(async () => {
      let modules: LogExportModules;
      try {
        modules = await loader();
      } catch {
        diagnostics.logOnce(
          "logs.packages-missing",
          `Log export is on but its packages are not installed. Install them with: ${INSTALL_COMMAND}. Logs are printed but not exported.`,
        );
        return;
      }
      if (active !== state) return; // shut down while loading
      try {
        const provider = new modules.LoggerProvider({
          resource: buildResource(options),
          processors: [
            new modules.BatchLogRecordProcessor({
              exporter: new modules.OTLPLogExporter({
                url: otlp.url,
                headers: { ...otlp.headers },
                timeoutMillis: otlp.timeoutMillis,
              }),
            }),
          ],
        });
        // False when a host provider holds the slot: use it, drop ours.
        if (logs.setGlobalLoggerProvider(provider)) state.provider = provider;
        else void settle(() => provider.shutdown());
        const logger = logs.getLogger("@nestrix/nestjs");
        state.sink = {
          emit(record) {
            logger.emit({
              severityNumber: SEVERITY[record.level],
              severityText: record.level.toUpperCase(),
              body: record.body,
              attributes: {
                ...(record.context && {
                  "nestrix.log.context": record.context,
                }),
                ...(record.stack && { "exception.stacktrace": record.stack }),
              },
              context: context.active(),
            });
          },
        };
        setLogSink(guarded(state.sink, diagnostics));
      } catch (error) {
        diagnostics.countFailure("logs.setup", error);
      }
    });
    return handle(state);
  } catch (error) {
    diagnostics.countFailure("logs.setup", error);
    return undefined;
  }
}

function guarded(sink: LogSink, diagnostics: TelemetryDiagnostics): LogSink {
  return {
    emit(record) {
      try {
        sink.emit(record);
      } catch (error) {
        diagnostics.countFailure("logs.emit", error);
      }
    },
  };
}

function handle(state: Active): LogExportHandle {
  let done: Promise<void> | undefined;
  return {
    shutdown() {
      done ??= settle(async () => {
        state.refs--;
        if (state.refs > 0) {
          const { provider } = state;
          if (provider) {
            await bounded(() => provider.forceFlush(), SHUTDOWN_TIMEOUT_MILLIS);
          }
          return;
        }
        if (active === state) active = undefined;
        setLogSink(undefined);
        await bounded(() => state.ready, SHUTDOWN_TIMEOUT_MILLIS);
        const { provider } = state;
        if (provider) {
          await bounded(() => provider.shutdown(), SHUTDOWN_TIMEOUT_MILLIS);
          try {
            logs.disable();
          } catch {
            // Nothing to undo.
          }
        }
      });
      return done;
    },
  };
}
