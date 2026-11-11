import { Controller, Get, Module, Param } from "@nestjs/common";
import { Redis } from "ioredis";
import { Redis as Redis5 } from "ioredis5";
import { SpikeNestrixModule } from "../nestrix/index.js";
import { closedPort, runHttpCases } from "./http-cases.js";
import { getStatusWithFetch, getStatusWithHttp } from "./out.js";
import {
  mysqlCallbackLater,
  mysqlContention,
  mysqlScenario,
  pgContention,
  pgScenario,
  redisScenario,
  withSpan,
} from "./scenarios.js";

const env = process.env;
const need = (name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};

@Controller("s")
export class ScenarioController {
  @Get(":name")
  async run(@Param("name") name: string): Promise<unknown> {
    const echo = need("ECHO_URL");
    switch (name) {
      case "out":
        // The same calls as the example apps' GET /out, inside an active span.
        return withSpan("handler out", async () => ({
          fetch: await getStatusWithFetch(`${echo}/fetch`),
          http: await getStatusWithHttp(`${echo}/http`),
        }));
      case "fetch-error":
        return withSpan("handler fetch-error", async () => {
          try {
            // A closed port (connection refused). Port 1 would not do: fetch rejects
            // it as a "bad port" before undici dispatches, so no span would exist.
            await fetch(`http://127.0.0.1:${await closedPort()}/unreachable`);
            return "unexpected";
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        });
      case "http-cases":
        return withSpan("handler http-cases", () => runHttpCases(echo));
      case "pg":
        return pgScenario(need("PG_URL"));
      case "pg-contention":
        return pgContention(need("PG_URL"));
      case "mysql":
        return mysqlScenario(need("MYSQL_URL"));
      case "mysql-contention":
        return mysqlContention(need("MYSQL_URL"));
      case "mysql-callback-later":
        return mysqlCallbackLater(need("MYSQL_URL"));
      case "redis":
        return redisScenario(need("REDIS_URL"), Redis);
      case "redis5":
        return redisScenario(
          need("REDIS_URL"),
          Redis5 as unknown as typeof Redis,
        );
      default:
        return { unknown: name };
    }
  }
}

@Module({
  // Instrumentation switches on here, while this module file is evaluated: inside the
  // app's import graph, with no --import/--require/loader flag.
  imports: [SpikeNestrixModule.forRoot()],
  controllers: [ScenarioController],
})
export class AppModule {}
