// NESTRIX_INGEST_MEMORY_BUDGET_MB (D-117): parsing, the caps derived from the budget (one request
// at every cap must fit it, at every allowed value), the defaults unchanged when it is unset, and
// a server at a small budget answering 413 over its scaled limits and 200 at them.

import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { create, toBinary } from "@bufbuild/protobuf";
import { Logger } from "@nestjs/common";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DEFAULT_INGEST, loadConfig, MIB } from "../../src/config.js";
import {
  DEFAULT_INGEST_CAPS,
  ingestCapsForBudget,
  MAX_INGEST_BUDGET_MIB,
  MIN_INGEST_BUDGET_MIB,
  worstCaseCharge,
} from "../../src/ingest/caps.js";
import {
  checkProtobuf,
  decodeCharge,
  TRACE_SHAPE,
} from "../../src/ingest/limits.js";
import { IngestReceiver } from "../../src/ingest/receiver.js";
import { ExportTraceServiceRequestSchema } from "../../src/proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import {
  auth,
  fixture,
  PROTO,
  post,
  startServer,
  type TestServer,
  testConfig,
} from "./helpers.js";

const DB = "postgres://localhost:5432/nestrix";
const NAME = "NESTRIX_INGEST_MEMORY_BUDGET_MB";

function ingestOf(env: Record<string, string>) {
  const result = loadConfig({ DATABASE_URL: DB, ...env });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.config.ingest;
}

function errorsOf(env: Record<string, string>): string[] {
  const result = loadConfig({ DATABASE_URL: DB, ...env });
  if (result.ok) throw new Error("expected invalid configuration");
  return result.errors;
}

describe(`${NAME}: parsing`, () => {
  it("reads whole MiB from 32 to 1024", () => {
    expect(ingestOf({ [NAME]: "32" }).inflightBudgetBytes).toBe(32 * MIB);
    expect(ingestOf({ [NAME]: " 128 " }).inflightBudgetBytes).toBe(128 * MIB);
    expect(ingestOf({ [NAME]: "1024" }).inflightBudgetBytes).toBe(1024 * MIB);
    expect(MIN_INGEST_BUDGET_MIB).toBe(32);
    expect(MAX_INGEST_BUDGET_MIB).toBe(1024);
  });

  it("refuses to start on anything else, with one clear message", () => {
    for (const bad of [
      "31",
      "0",
      "1025",
      "64MiB",
      "64M",
      "1e2",
      "-64",
      "2.5",
      "0x40",
      "lots",
    ]) {
      const list = errorsOf({ [NAME]: bad });
      expect(list).toEqual([
        `${NAME} must be a whole number from 32 to 1024 (got "${bad}").`,
      ]);
    }
  });

  it("treats an empty value as unset", () => {
    expect(ingestOf({ [NAME]: "  " })).toEqual(ingestOf({}));
  });
});

describe(`${NAME}: defaults unchanged`, () => {
  it("leaves every ingest limit as before when unset", () => {
    // The values before D-117, written out.
    const before = {
      maxBodyBytes: 20 * MIB,
      rateLimit: { requestsPerSecond: 100, burst: 200 },
      maxSpans: 100_000,
      maxMessages: 400_000,
      maxJsonTokens: 1_200_000,
      inflightBudgetBytes: 320 * MIB,
      discardTimeoutMs: 5_000,
    };
    expect(DEFAULT_INGEST).toEqual(before);
    const ingest = ingestOf({});
    const { auth: _a, keys: _k, keyEnvironments: _e, ...limits } = ingest;
    expect(limits).toEqual(before);
    expect(Object.keys(ingest).sort()).toEqual(
      [...Object.keys(before), "auth", "keys", "keyEnvironments"].sort(),
    );
  });

  it("derives exactly the defaults at 320 MiB, and keeps them above it", () => {
    expect(ingestCapsForBudget(320 * MIB)).toEqual(DEFAULT_INGEST_CAPS);
    expect(ingestOf({ [NAME]: "320" })).toEqual(ingestOf({}));
    const big = ingestOf({ [NAME]: "1024" });
    expect(big.inflightBudgetBytes).toBe(1024 * MIB);
    expect({
      maxBodyBytes: big.maxBodyBytes,
      maxSpans: big.maxSpans,
      maxMessages: big.maxMessages,
      maxJsonTokens: big.maxJsonTokens,
    }).toEqual(DEFAULT_INGEST_CAPS);
  });

  it("states the default worst case of D-116: 304 MiB protobuf, 312 MiB JSON (311.9)", () => {
    const worst = worstCaseCharge(DEFAULT_INGEST_CAPS);
    expect(worst.protobuf / MIB).toBeCloseTo(304.1, 1);
    expect(worst.json / MIB).toBeCloseTo(311.9, 1);
  });
});

describe(`${NAME}: the derived caps fit the budget`, () => {
  it("one request at every cap fits, at every allowed value", () => {
    let previous = ingestCapsForBudget(0);
    for (let mib = MIN_INGEST_BUDGET_MIB; mib <= MAX_INGEST_BUDGET_MIB; mib++) {
      const ingest = ingestOf({ [NAME]: String(mib) });
      const budget = mib * MIB;
      expect(ingest.inflightBudgetBytes).toBe(budget);
      const caps = {
        maxBodyBytes: ingest.maxBodyBytes,
        maxSpans: ingest.maxSpans,
        maxMessages: ingest.maxMessages,
        maxJsonTokens: ingest.maxJsonTokens,
      };
      const worst = worstCaseCharge(caps);
      expect(worst.protobuf).toBeLessThanOrEqual(budget);
      expect(worst.json).toBeLessThanOrEqual(budget);
      // Never above the defaults, never smaller for a larger budget.
      for (const key of Object.keys(caps) as (keyof typeof caps)[]) {
        expect(caps[key]).toBeLessThanOrEqual(DEFAULT_INGEST_CAPS[key]);
        expect(caps[key]).toBeGreaterThanOrEqual(previous[key]);
        expect(Number.isSafeInteger(caps[key])).toBe(true);
      }
      previous = caps;
    }
  });

  it("keeps a Collector batch (8 192 spans) under the span cap at the minimum", () => {
    const caps = ingestCapsForBudget(MIN_INGEST_BUDGET_MIB * MIB);
    expect(caps).toEqual({
      maxBodyBytes: 2 * MIB,
      maxSpans: 10_000,
      maxMessages: 40_000,
      maxJsonTokens: 120_000,
    });
    expect(caps.maxSpans).toBeGreaterThanOrEqual(8_192);
  });
});

/** A protobuf export of `spans` spans with `events` events each and `pad` bytes of name. */
function traceBody(spans: number, events: number, pad = 0): Buffer {
  const traceId = randomBytes(16);
  // Now: spans far in the future are rejected one by one.
  const start = BigInt(Date.now()) * 1_000_000n;
  const name = `op${"x".repeat(pad)}`;
  return Buffer.from(
    toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: Array.from({ length: spans }, (_, i) => ({
                  traceId,
                  spanId: randomBytes(8),
                  name,
                  kind: 2,
                  startTimeUnixNano: start + BigInt(i),
                  endTimeUnixNano: start + BigInt(i) + 1000n,
                  events: Array.from({ length: events }, () => ({
                    timeUnixNano: start + BigInt(i),
                  })),
                })),
              },
            ],
          },
        ],
      }),
    ),
  );
}

/** POST with `Transfer-Encoding: chunked`, in 64 KiB writes; resolves with the status. */
function postChunked(url: string, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          ...auth(),
          "content-type": PROTO,
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    for (let off = 0; off < body.length; off += 64 * 1024) {
      req.write(body.subarray(off, off + 64 * 1024));
    }
    req.end();
  });
}

describe(`receiver at ${NAME}=32`, () => {
  let server: TestServer;
  const logged: string[] = [];
  beforeAll(async () => {
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation(function (
      this: Logger,
      message: unknown,
    ) {
      logged.push(String(message));
    });
    server = await startServer(testConfig({ [NAME]: "32" }));
    spy.mockRestore();
  });
  afterAll(async () => {
    await server?.close();
  });

  it("logs the budget and the effective caps at start", () => {
    expect(logged).toContainEqual(
      expect.stringMatching(
        /^NESTRIX_INGEST_MEMORY_BUDGET_MB: 32 MiB for requests in flight; per request at most 2 MiB of body \(2097152 bytes\), 10000 spans, 40000 messages, 120000 JSON values\./,
      ),
    );
  });

  it("answers 413 for a body one byte over the scaled limit", async () => {
    // Chunked, with no declared length: the server reads up to the limit, answers 413 and
    // discards the rest (with a declared length over the limit it closes without reading).
    expect(await postChunked(server.url, Buffer.alloc(2 * MIB + 1))).toBe(413);
  });

  it("answers 413 for one span over the scaled span cap", async () => {
    const res = await post(server.url, traceBody(10_001, 0), {
      ...auth(),
      "content-type": PROTO,
    });
    expect(res.status).toBe(413);
  });

  it("accepts a request at the message and span caps", async () => {
    // 9 999 spans of 3 events: 39 996 + 2 messages, under 40 000.
    const body = traceBody(9_999, 3);
    const cost = checkProtobuf(
      body,
      { maxSpans: 10_000, maxMessages: 40_000, maxJsonTokens: 0, maxDepth: 64 },
      TRACE_SHAPE,
    );
    expect(cost.spans).toBe(9_999);
    expect(cost.messages).toBe(39_998);
    expect(3 * body.length + decodeCharge(cost)).toBeLessThanOrEqual(32 * MIB);
    const before = server.sink.spans().length;
    const res = await post(server.url, body, {
      ...auth(),
      "content-type": PROTO,
    });
    expect(res.status).toBe(200);
    expect(server.sink.spans().length - before).toBe(9_999);
  });

  it("accepts a body at the scaled size limit", async () => {
    // Few spans with long names, padded to just under 2 MiB.
    const per = traceBody(1, 0, 64 * 1024).length;
    const count = Math.floor((2 * MIB) / per);
    const body = traceBody(count, 0, 64 * 1024);
    expect(body.length).toBeLessThanOrEqual(2 * MIB);
    expect(body.length).toBeGreaterThan(2 * MIB - per);
    const res = await post(server.url, body, {
      ...auth(),
      "content-type": PROTO,
    });
    expect(res.status).toBe(200);
    expect(server.app.get(IngestReceiver).budget.inUse).toBe(0);
  });
});

describe(`${NAME}: the start-up line cannot stop the server`, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts and answers when logging the line throws", async () => {
    const original = Logger.prototype.log;
    vi.spyOn(Logger.prototype, "log").mockImplementation(function (
      this: Logger,
      message: unknown,
      ...rest: unknown[]
    ) {
      if (String(message).startsWith(NAME)) throw new Error("injected");
      return original.call(this, message, ...(rest as []));
    });
    const server = await startServer(testConfig({ [NAME]: "64" }));
    try {
      const res = await post(server.url, fixture("traces.pb"), {
        ...auth(),
        "content-type": PROTO,
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
