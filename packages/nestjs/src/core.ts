import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { diagnostics } from "./diagnostics.js";
import { setupTelemetry } from "./otel/setup.js";
import type { TelemetryHandle } from "./otel/types.js";
import { buildRedactedQueryKeys, scrubSpanAttributes } from "./privacy.js";
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

  constructor(@Inject(NESTRIX_OPTIONS) readonly options: ResolvedOptions) {
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
        // P1-06: install HTTP hooks (check describeForeignRouteHook first and log the result)
      }
    } catch (error) {
      diagnostics.countFailure("core.constructor", error);
    }
    this.telemetry = telemetry;
  }

  /** Runs on `app.close()`; on SIGTERM/SIGINT only with `app.enableShutdownHooks()`. Never rejects. */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.telemetry?.shutdown();
    } catch (error) {
      diagnostics.countFailure("core.shutdown", error);
    }
  }
}
