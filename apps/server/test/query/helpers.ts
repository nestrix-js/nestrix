import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/bootstrap.js";
import { QUERY_GUARD } from "../../src/query/guard.js";
import { testConfig } from "../ingest/helpers.js";

export interface QueryServer {
  app: NestExpressApplication;
  baseUrl: string;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  json<T = unknown>(path: string): Promise<T>;
  close(): Promise<void>;
}

/**
 * The whole server (receiver, PostgreSQL storage, query API) against `databaseUrl`. With
 * `open`, the query guard allows every request (what P5-04's session guard does after login);
 * without it the default guard stays and the API is closed.
 */
export async function startQueryServer(
  databaseUrl: string,
  open = true,
): Promise<QueryServer> {
  const config = testConfig({ DATABASE_URL: databaseUrl });
  let builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  });
  if (open) {
    builder = builder
      .overrideProvider(QUERY_GUARD)
      .useValue({ canActivate: () => true });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { headers });
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
