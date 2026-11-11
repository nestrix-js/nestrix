import { type DynamicModule, Module } from "@nestjs/common";
import { enableIoredis, enableMysql2 } from "./channels.js";
import { failures, faults } from "./guard.js";
import { enableHttpClient, httpChannelsSeen } from "./http-client.js";
import { enablePg, type PgResult } from "./pg.js";
import {
  contextStorage,
  finishedSpans,
  resetSpans,
  setupTracing,
} from "./tracing.js";
import { enableUndici, type UndiciResult } from "./undici.js";

export interface SpikeOptions {
  pgDedupe?: boolean;
  httpCloseFallback?: boolean;
  httpEndOn?: "headers" | "body";
  httpOverwriteTraceparent?: boolean;
  /** Lend the pool caller's context to mysql2 queries started in the pool callback. */
  mysqlPoolParent?: boolean;
  /** Also bind the caller context to the whole pool callback (asyncStart.bindStore). */
  mysqlPoolBindStore?: boolean;
  /** Names of guarded bodies to throw in (fault injection). */
  faults?: string[];
}

export interface EnableReport {
  tracing: ReturnType<typeof setupTracing>["registered"];
  undici: UndiciResult;
  pg: PgResult;
  enabledAt: string;
}

let report: EnableReport | undefined;

/** Stand-in for what `NestrixModule.forRoot()` would switch on at module initialisation. */
export function enableAll(options: SpikeOptions = {}): EnableReport {
  if (report) return report;
  for (const f of options.faults ?? []) faults.add(f);
  const tracing = setupTracing();
  const undici = enableUndici();
  enableHttpClient({
    closeFallback: options.httpCloseFallback,
    endOn: options.httpEndOn,
    overwriteTraceparent: options.httpOverwriteTraceparent,
  });
  enableMysql2({
    poolParent: options.mysqlPoolParent,
    poolBindStore: options.mysqlPoolBindStore ? contextStorage() : undefined,
  });
  enableIoredis();
  const pg = enablePg({ dedupe: options.pgDedupe });
  report = {
    tracing: tracing.registered,
    undici,
    pg,
    enabledAt: new Error().stack?.split("\n").slice(2, 6).join(" | ") ?? "",
  };
  return report;
}

export function enableReport(): EnableReport | undefined {
  return report;
}

export function optionsFromEnv(): SpikeOptions {
  const env = process.env;
  return {
    pgDedupe: env.NESTRIX_PG_DEDUPE !== "0",
    httpCloseFallback: env.NESTRIX_HTTP_CLOSE_FALLBACK === "1",
    httpEndOn: env.NESTRIX_HTTP_END_ON === "headers" ? "headers" : "body",
    httpOverwriteTraceparent: env.NESTRIX_HTTP_OVERWRITE === "1",
    mysqlPoolParent: env.NESTRIX_MYSQL_POOL_PARENT !== "0",
    mysqlPoolBindStore: env.NESTRIX_MYSQL_POOL_BINDSTORE === "1",
    faults: env.NESTRIX_FAULTS ? env.NESTRIX_FAULTS.split(",") : [],
  };
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest module pattern
export class SpikeNestrixModule {
  static forRoot(options: SpikeOptions = optionsFromEnv()): DynamicModule {
    enableAll(options);
    return { module: SpikeNestrixModule, global: true };
  }
}

export { disablePgExports, enablePg, instrumentPgExports } from "./pg.js";
export type { SpanRecord } from "./tracing.js";
export {
  failures,
  faults,
  finishedSpans,
  httpChannelsSeen,
  resetSpans,
  setupTracing,
};
