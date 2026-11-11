import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { diagnostics } from "./diagnostics.js";
import { installHttpInstrumentation } from "./http/server.js";
import { setupTelemetry } from "./otel/setup.js";
import type { TelemetryHandle } from "./otel/types.js";
import { buildRedactedQueryKeys, scrubSpanAttributes } from "./privacy.js";
import { installProcessErrorMonitor } from "./process-errors.js";
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
export class NestrixCore implements OnApplicationShutdown {
  /** Undefined when disabled or when setup failed. */
  readonly telemetry: TelemetryHandle | undefined;
  private readonly disposers: Array<() => void> = [];

  constructor(
    @Inject(NESTRIX_OPTIONS) readonly options: ResolvedOptions,
    // Explicit token, so injection does not depend on `design:paramtypes` being emitted.
    @Optional() @Inject(HttpAdapterHost) adapterHost?: HttpAdapterHost,
  ) {
    let telemetry: TelemetryHandle | undefined;
    try {
      if (options.enabled) {
        const queryKeys = buildRedactedQueryKeys(options.http.redactQueryKeys);
        telemetry = setupTelemetry(
          {
            ...options,
            scrub: (span) => scrubSpanAttributes(span, queryKeys),
          },
          diagnostics,
        );
        // HTTP hooks now, or from `init$` under @nestjs/testing; nothing without an adapter.
        this.disposers.push(
          installHttpInstrumentation(adapterHost, options, diagnostics),
          installProcessErrorMonitor(),
        );
      }
    } catch (error) {
      diagnostics.countFailure("core.constructor", error);
    }
    this.telemetry = telemetry;
  }

  /** Runs on `app.close()`; on SIGTERM/SIGINT only with `app.enableShutdownHooks()`. Never rejects. */
  async onApplicationShutdown(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        diagnostics.countFailure("core.shutdown", error);
      }
    }
    try {
      await this.telemetry?.shutdown();
    } catch (error) {
      diagnostics.countFailure("core.shutdown", error);
    }
  }
}
