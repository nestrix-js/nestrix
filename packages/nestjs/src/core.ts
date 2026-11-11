import { Inject, Injectable } from "@nestjs/common";
import { diagnostics } from "./diagnostics.js";
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
export class NestrixCore {
  constructor(@Inject(NESTRIX_OPTIONS) readonly options: ResolvedOptions) {
    try {
      if (!options.enabled) return;
      // P1-03: setupTelemetry(options, diagnostics)
      // P1-06: install HTTP hooks
    } catch (error) {
      diagnostics.countFailure("core.constructor", error);
    }
  }
}
