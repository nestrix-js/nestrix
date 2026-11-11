import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/bootstrap.js";
import { DenyQueryGuard, QUERY_GUARD } from "../../src/query/guard.js";
import { ADMIN_PW, SESSION_SECRET, signedCookie } from "../auth/helpers.js";
import { lastServer, testConfig } from "../ingest/helpers.js";

export interface QueryServer {
  app: NestExpressApplication;
  baseUrl: string;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  json<T = unknown>(path: string): Promise<T>;
  close(): Promise<void>;
}

/**
 * The whole server (receiver, PostgreSQL storage, admin login, query API) against `databaseUrl`.
 * `get` and `json` send a signed admin session cookie, unless `signedIn` is false. With `open`
 * the real session guard guards the query API; without it the default deny guard replaces it
 * (the API stays closed even for a signed-in admin).
 */
export async function startQueryServer(
  databaseUrl: string,
  open = true,
  signedIn = true,
): Promise<QueryServer> {
  const config = testConfig({
    DATABASE_URL: databaseUrl,
    NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
    NESTRIX_SESSION_SECRET: SESSION_SECRET,
  });
  let builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  });
  if (!open) {
    builder = builder
      .overrideProvider(QUERY_GUARD)
      .useValue(new DenyQueryGuard());
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, config);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  lastServer.port = port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      headers: signedIn
        ? {
            cookie: signedCookie(undefined, undefined, undefined, port),
            ...headers,
          }
        : headers,
    });
  return {
    app,
    baseUrl,
    get,
    async json<T>(path: string): Promise<T> {
      const res = await get(path);
      if (res.status !== 200) {
        throw new Error(
          `GET ${path} answered ${res.status}: ${await res.text()}`,
        );
      }
      return (await res.json()) as T;
    },
    close: async () => {
      app.getHttpServer().closeAllConnections();
      await app.close();
    },
  };
}
