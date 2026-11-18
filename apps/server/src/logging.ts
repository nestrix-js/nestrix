/**
 * The server's logger (#47, D-95): Nest's `ConsoleLogger`, as one JSON object per line without
 * colours (`NESTRIX_LOG_FORMAT=json`, the default under `NODE_ENV=production`) or as Nest's text
 * lines, at `NESTRIX_LOG_LEVEL`. At `info` and above, the lines that list every mapped route
 * (contexts `RoutesResolver` and `RouterExplorer`) are dropped; `debug` and `verbose` show them.
 */
import { ConsoleLogger } from "@nestjs/common";
import type { LogConfig } from "./config.js";

const ROUTE_MAPPING_CONTEXTS: ReadonlySet<unknown> = new Set([
  "RoutesResolver",
  "RouterExplorer",
]);

export class ServerLogger extends ConsoleLogger {
  private readonly hideRouteMapping: boolean;

  constructor(config: LogConfig) {
    super({
      json: config.json,
      // Text mode keeps Nest's own colour decision (a terminal, `NO_COLOR`).
      ...(config.json ? { colors: false } : {}),
      logLevels: [...config.levels],
    });
    this.hideRouteMapping = config.hideRouteMapping;
  }

  override log(message: unknown, ...optionalParams: unknown[]): void {
    if (
      this.hideRouteMapping &&
      ROUTE_MAPPING_CONTEXTS.has(optionalParams[optionalParams.length - 1])
    ) {
      return;
    }
    super.log(message, ...optionalParams);
  }
}
