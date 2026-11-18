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

import type { Agent as HttpAgent } from "node:http";
import type { LogLevel } from "@nestjs/common";
import {
  type Attributes,
  context,
  logs,
  SeverityNumber,
} from "@opentelemetry/api";
import type {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  activateExport,
  deactivateExport,
  recordExportDropped,
} from "../export-status.js";
import {
  createExportAgents,
  type ResponseStatusTracker,
} from "../otel/export-agent.js";
import { observeExports } from "../otel/observe-export.js";
import {
  createDropCountingMeterProvider,
  LOG_PROCESSED_METRIC,
} from "../otel/pipeline.js";
import { settle } from "../otel/redacting-exporter.js";
import { buildResource } from "../otel/resource.js";
import type { TelemetryDiagnostics } from "../otel/types.js";
import { buildRedactedQueryKeys, scrubSpanAttributes } from "../privacy.js";
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
    httpAgentOptions?: (protocol: string) => HttpAgent;
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
  > &
    // For `http.redactQueryKeys` (D-112); without it, the default keys apply.
    Partial<Pick<ResolvedOptions, "http">>,
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
    const queryKeys = buildRedactedQueryKeys(options.http?.redactQueryKeys);
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
        // D-82: the exporter's agents (unref'ed sockets, as for traces) also report the HTTP
        // status of each answer, and every export's result feeds getExportStatus().logs.
        const tracker: ResponseStatusTracker = { lastStatus: undefined };
        const agents = createExportAgents(tracker);
        const exporter = observeExports(
          new modules.OTLPLogExporter({
            url: otlp.url,
            headers: { ...otlp.headers },
            timeoutMillis: otlp.timeoutMillis,
            httpAgentOptions: (protocol: string) => agents.factory(protocol),
          }),
          { signal: "logs", tracker },
        ) as ConstructorParameters<
          typeof BatchLogRecordProcessor
        >[0]["exporter"];
        const provider = new modules.LoggerProvider({
          resource: buildResource(options),
          processors: [
            new modules.BatchLogRecordProcessor({
              exporter,
              // Queue-full drops, counted as for spans (pipeline.ts).
              selfObsMeterProvider: createDropCountingMeterProvider(
                (count) => recordExportDropped("logs", count),
                LOG_PROCESSED_METRIC,
              ),
            }),
          ],
        });
        // False when a host provider holds the slot: use it, drop ours.
        if (logs.setGlobalLoggerProvider(provider)) {
          state.provider = provider;
          activateExport("logs");
        } else void settle(() => provider.shutdown());
        const logger = logs.getLogger("@nestrix-js/nestjs");
        state.sink = {
          emit(record) {
            let attributes: Attributes | undefined;
            try {
              attributes = scrubbedLogAttributes(record.attributes, queryKeys);
            } catch (error) {
              // Fail closed: attributes that cannot be cleaned are not sent, nor is the record.
              recordExportDropped("logs", 1);
              diagnostics.countFailure("logs.redact", error);
              return;
            }
            logger.emit({
              severityNumber: SEVERITY[record.level],
              severityText: record.level.toUpperCase(),
              body: record.body,
              attributes: {
                ...attributes,
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

/**
 * `emitLog`'s attributes with Nestrix's built-in scrub rule applied (D-112): the always-redacted
 * headers under `http.request.header.*` / `http.response.header.*`, listed query keys in
 * `url.query` and `url.full`, and `url.full`'s fragment and userinfo. Works on a copy; the
 * caller's object is never changed. An attribute that cannot be read is left out. Throws when
 * the map cannot be walked or an attribute cannot be removed; the caller drops the record.
 */
export function scrubbedLogAttributes(
  attributes: Attributes | undefined,
  keys: ReadonlySet<string>,
): Attributes | undefined {
  if (attributes === undefined || attributes === null) return undefined;
  if (typeof attributes !== "object" || Array.isArray(attributes)) {
    return undefined;
  }
  // No prototype: an own `__proto__` key stays a plain key.
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(attributes)) {
    try {
      const value = attributes[key];
      copy[key] = Array.isArray(value) ? value.slice() : value;
    } catch {
      // Unreadable: left out.
    }
  }
  scrubSpanAttributes({ attributes: copy }, keys);
  return copy as Attributes;
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
          deactivateExport("logs");
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
