import "reflect-metadata";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/bootstrap.js";
import {
  type IngestConfig,
  loadConfig,
  type ServerConfig,
} from "../../src/config.js";
import type { IngestBatch, IngestSink } from "../../src/ingest/model.js";
import { INGEST_SINK } from "../../src/ingest/tokens.js";

export const KEY = `${"k".repeat(16)}0123456789abcdef0123`;
export const OTHER_KEY = "z".repeat(40);

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export function fixture(name: string): Buffer {
  return readFileSync(join(fixtures, name));
}
export const expected = JSON.parse(fixture("expected.json").toString("utf8"));

export class RecordingSink implements IngestSink {
  readonly batches: IngestBatch[] = [];
  /** Replace to make `write` fail or wait. */
  behaviour: (batch: IngestBatch) => Promise<void> = async () => {};
  async write(batch: IngestBatch): Promise<void> {
    await this.behaviour(batch);
    this.batches.push(batch);
  }
  spans() {
    return this.batches.flatMap((b) => b.resourceSpans.flatMap((r) => r.spans));
  }
}

export function testConfig(
  env: Record<string, string> = {},
  ingest: Partial<IngestConfig> = {},
): ServerConfig {
  const result = loadConfig({
    DATABASE_URL: "postgres://localhost:5432/nestrix",
    NESTRIX_INGEST_KEYS: `${KEY},${OTHER_KEY}`,
    ...env,
  });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return {
    ...result.config,
    ingest: { ...result.config.ingest, ...ingest },
  };
}

export interface TestServer {
  app: NestExpressApplication;
  baseUrl: string;
  url: string;
  sink: RecordingSink;
  close: () => Promise<void>;
}

export async function startServer(
  config: ServerConfig = testConfig(),
): Promise<TestServer> {
  const sink = new RecordingSink();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  })
    .overrideProvider(INGEST_SINK)
    .useValue(sink)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, config);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    app,
    baseUrl,
    url: `${baseUrl}/v1/traces`,
    sink,
    close: async () => {
      // Keep-alive sockets left by raw-request tests would hold close() for keepAliveTimeout.
      app.getHttpServer().closeAllConnections();
      await app.close();
    },
  };
}

export const PROTO = "application/x-protobuf";
export const JSON_TYPE = "application/json";

export function post(
  url: string,
  body: Uint8Array | string,
  headers: Record<string, string>,
): Promise<Response> {
  // fetch's BodyInit wants a Uint8Array over an ArrayBuffer; Buffers may sit on a shared pool.
  const payload = typeof body === "string" ? body : Uint8Array.from(body);
  return fetch(url, { method: "POST", body: payload, headers });
}

export function auth(key = KEY): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}
