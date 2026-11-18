/** Issue #28 (D-101): ingest keys bound to an environment. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  auth,
  fixture,
  KEY,
  OTHER_KEY,
  post,
  startServer,
  type TestServer,
  testConfig,
} from "./helpers.js";

const DB = "postgres://localhost:5432/nestrix";

describe("NESTRIX_INGEST_KEYS bindings", () => {
  it("reads <environment>:<key> and leaves plain keys unbound", () => {
    const r = loadConfig({
      DATABASE_URL: DB,
      NESTRIX_INGEST_KEYS: `staging:${KEY},${OTHER_KEY}`,
    });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.config.ingest.keys).toEqual([KEY, OTHER_KEY]);
    expect(r.config.ingest.keyEnvironments).toEqual(["staging", null]);
  });

  it("refuses a bad environment name, `unset`, and one key bound twice differently", () => {
    for (const keys of [
      `bad name:${KEY}`,
      `unset:${KEY}`,
      `staging:${KEY},production:${KEY}`,
    ]) {
      const r = loadConfig({ DATABASE_URL: DB, NESTRIX_INGEST_KEYS: keys });
      expect(r.ok, keys).toBe(false);
    }
  });
});

describe("a key bound to an environment", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(
      testConfig({
        NESTRIX_INGEST_KEYS: `staging:${KEY},production:${OTHER_KEY}`,
      }),
    );
  });
  afterAll(async () => {
    await server?.close();
  });

  it("stores whatever it sends under its own environment, whatever the resource claims", async () => {
    // The recorded body names no environment: the bound key supplies it.
    for (const [key, environment] of [
      [KEY, "staging"],
      [OTHER_KEY, "production"],
    ] as const) {
      const before = server.sink.batches.length;
      const res = await post(server.url, fixture("traces.json"), {
        ...auth(key),
        "content-type": "application/json",
      });
      expect(res.status).toBe(200);
      const written = server.sink.batches.slice(before);
      expect(written.length).toBeGreaterThan(0);
      for (const b of written) {
        for (const rs of b.resourceSpans) {
          expect(rs.resource?.["deployment.environment.name"]).toBe(
            environment,
          );
          expect(rs.resource?.["deployment.environment"]).toBeUndefined();
        }
      }
    }
  });
});

describe("a key bound to an environment, log lines (NESTRIX_LOGS=all)", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(
      testConfig({
        NESTRIX_INGEST_KEYS: `staging:${KEY}`,
        NESTRIX_LOGS: "all",
      }),
    );
  });
  afterAll(async () => {
    await server?.close();
  });

  it("stores trace-less and traced lines under the key's environment, whatever the resource claims", async () => {
    const nano = String(BigInt(Date.now()) * 1_000_000n);
    const body = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "shop" } },
              {
                key: "deployment.environment.name",
                value: { stringValue: "production" },
              },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: nano,
                  severityNumber: 9,
                  body: { stringValue: "worker started" },
                },
                {
                  timeUnixNano: nano,
                  severityNumber: 17,
                  body: { stringValue: "in a request" },
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "b7ad6b7169203331",
                },
              ],
            },
          ],
        },
      ],
    });
    const res = await post(`${server.baseUrl}/v1/logs`, body, {
      ...auth(KEY),
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    const written = server.sink.logBatches.flatMap((b) => b.resourceLogs);
    const records = written.flatMap((rl) => rl.records);
    expect(records.map((r) => r.traceId === "").sort()).toEqual([false, true]);
    for (const rl of written) {
      expect(rl.resource?.["deployment.environment.name"]).toBe("staging");
    }
  });
});
