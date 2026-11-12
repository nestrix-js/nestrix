// POST /v1/logs (P9-07): the trace receiver's hardening, mirrored for log exports. Untrusted input:
// auth by ingest key, body and decompressed caps, the object-count pre-walk (bombs), the memory
// budget, the shared rate limit, partial success, string caps and malformed bodies. Only records
// with a trace id are kept. Vitest fails the run on any unhandled error, so "never crashes" is
// checked throughout.
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIB } from "../../src/config.js";
import { decodeLogsRequest } from "../../src/ingest/decode.js";
import { toIngestLogBatch } from "../../src/ingest/map-logs.js";
import { MemoryIngestSink } from "../../src/ingest/memory-sink.js";
import { IngestBusyError } from "../../src/ingest/model.js";
import { IngestReceiver } from "../../src/ingest/receiver.js";
import { StatusSchema } from "../../src/proto/gen/google/rpc/status_pb.js";
import {
  ExportLogsServiceRequestSchema,
  ExportLogsServiceResponseSchema,
} from "../../src/proto/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js";
import {
  auth,
  JSON_TYPE,
  OTHER_KEY,
  PROTO,
  post,
  startServer,
  type TestServer,
  testConfig,
} from "./helpers.js";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const SPAN = "b7ad6b7169203331";
const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString();

interface JsonRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityNumber?: number;
  severityText?: string;
  body?: unknown;
  traceId?: string;
  spanId?: string;
  attributes?: unknown[];
}

function record(over: JsonRecord = {}): JsonRecord {
  return {
    timeUnixNano: nowNs(),
    severityNumber: 9,
    severityText: "INFO",
    body: { stringValue: "hello" },
    traceId: TRACE,
    spanId: SPAN,
    attributes: [
      { key: "nestrix.log.context", value: { stringValue: "UsersService" } },
    ],
    ...over,
  };
}

function logsJson(records: JsonRecord[]) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "svc" } }],
        },
        scopeLogs: [
          { scope: { name: "@nestrix-js/nestjs" }, logRecords: records },
        ],
      },
    ],
  };
}

function protoBody(): Uint8Array {
  const request = create(ExportLogsServiceRequestSchema, {
    resourceLogs: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { value: { case: "stringValue", value: "svc" } },
            },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: BigInt(nowNs()),
                severityNumber: 17,
                severityText: "ERROR",
                body: { value: { case: "stringValue", value: "boom" } },
                traceId: Buffer.from(TRACE, "hex"),
                spanId: Buffer.from(SPAN, "hex"),
              },
              // No trace: accepted, not kept, not rejected.
              {
                timeUnixNano: BigInt(nowNs()),
                body: { value: { case: "stringValue", value: "no trace" } },
              },
            ],
          },
        ],
      },
    ],
  });
  return toBinary(ExportLogsServiceRequestSchema, request);
}

async function statusMessage(res: Response): Promise<string> {
  const type = res.headers.get("content-type");
  if (type === PROTO) {
    return fromBinary(StatusSchema, new Uint8Array(await res.arrayBuffer()))
      .message;
  }
  expect(type).toBe(JSON_TYPE);
  return (await res.json()).message;
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
function field(tag: number, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([tag, ...varint(content.length)]),
    content,
  ]);
}
function repeat(pair: number[], n: number): Buffer {
  const out = Buffer.alloc(pair.length * n);
  for (let i = 0; i < n; i++) out.set(pair, i * pair.length);
  return out;
}
/** ExportLogsServiceRequest{ resource_logs(1){ scope_logs(2){ <content> } } }; log_records is field 2. */
function inScopeLogs(content: Buffer): Buffer {
  return field(0x0a, field(0x12, content));
}

describe("POST /v1/logs", () => {
  let server: TestServer;
  let logsUrl: string;
  const send = (body: Uint8Array | string, headers: Record<string, string>) =>
    post(logsUrl, body, headers);
  async function expectAlive() {
    const res = await send(JSON.stringify(logsJson([record()])), {
      ...auth(),
      "content-type": JSON_TYPE,
    });
    expect(res.status).toBe(200);
  }

  beforeAll(async () => {
    server = await startServer(
      testConfig({}, { rateLimit: { requestsPerSecond: 1e6, burst: 1e6 } }),
    );
    logsUrl = `${server.baseUrl}/v1/logs`;
  });
  afterAll(async () => {
    await server?.close();
  });

  describe("accepted records", () => {
    it("keeps records with a trace id (JSON), drops those without, answers full success", async () => {
      const before = server.sink.logBatches.length;
      const res = await send(
        JSON.stringify(
          logsJson([
            record(),
            record({ traceId: undefined, body: { stringValue: "no trace" } }),
            record({ traceId: "0".repeat(32), body: { stringValue: "zero" } }),
            record({
              spanId: undefined,
              body: {
                kvlistValue: {
                  values: [{ key: "a", value: { intValue: "1" } }],
                },
              },
            }),
          ]),
        ),
        { ...auth(), "content-type": JSON_TYPE },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("{}");
      const batch = server.sink.logBatches[before];
      expect(batch?.rejectedLogRecords).toBe(0);
      expect(batch?.resourceLogs[0]?.resource["service.name"]).toBe("svc");
      const records = batch?.resourceLogs[0]?.records ?? [];
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        traceId: TRACE,
        spanId: SPAN,
        severityNumber: 9,
        severityText: "INFO",
        body: "hello",
        context: "UsersService",
      });
      expect(records[1]?.spanId).toBeUndefined();
      expect(records[1]?.body).toBe('{"a":1}');
      // A server span is not created for ingest, and the trace sink saw nothing.
      expect(server.sink.batches).toHaveLength(0);
    });

    it("protobuf in, protobuf out", async () => {
      const before = server.sink.logBatches.length;
      const res = await send(protoBody(), { ...auth(), "content-type": PROTO });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(PROTO);
      const answer = fromBinary(
        ExportLogsServiceResponseSchema,
        new Uint8Array(await res.arrayBuffer()),
      );
      expect(answer.partialSuccess).toBeUndefined();
      const records = server.sink.logBatches[before]?.resourceLogs[0]?.records;
      expect(records?.map((r) => r.body)).toEqual(["boom"]);
      expect(records?.[0]?.severityNumber).toBe(17);
    });

    it("an empty request, or one with no traced record, is full success without calling the sink", async () => {
      const before = server.sink.logBatches.length;
      for (const body of [
        "{}",
        JSON.stringify(logsJson([record({ traceId: "" })])),
      ]) {
        const res = await send(body, { ...auth(), "content-type": JSON_TYPE });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("{}");
      }
      const empty = await send(new Uint8Array(0), {
        ...auth(),
        "content-type": PROTO,
      });
      expect(empty.status).toBe(200);
      expect(server.sink.logBatches.length).toBe(before);
    });

    it("the path matches as Express routes it (case, trailing slash); the body is left to the receiver", async () => {
      for (const path of ["/v1/logs/", "/V1/Logs"]) {
        const res = await post(
          `${server.baseUrl}${path}`,
          JSON.stringify(logsJson([record()])),
          {
            ...auth(),
            "content-type": JSON_TYPE,
          },
        );
        expect(res.status, path).toBe(200);
      }
    });
  });

  describe("partial success", () => {
    it("rejects invalid records individually and says why", async () => {
      const future = (
        BigInt(Date.now() + 3 * 86_400_000) * 1_000_000n
      ).toString();
      const before = server.sink.logBatches.length;
      const res = await send(
        JSON.stringify(
          logsJson([
            record(),
            record({ traceId: "zz" }),
            record({ spanId: "abcd" }),
            record({ timeUnixNano: "0", observedTimeUnixNano: "0" }),
            record({ timeUnixNano: future }),
            record({ timeUnixNano: "18446744073709551615" }),
            // Observed time stands in for a missing time.
            record({ timeUnixNano: "0", observedTimeUnixNano: nowNs() }),
          ]),
        ),
        { ...auth(), "content-type": JSON_TYPE },
      );
      expect(res.status).toBe(200);
      const answer = await res.json();
      expect(answer.partialSuccess.rejectedLogRecords).toBe("5");
      expect(answer.partialSuccess.errorMessage).toBe(
        "Rejected 5 of 7 log records: invalid trace id (1), invalid span id (1), missing time (1), time more than a day in the future (1), time out of range (1).",
      );
      expect(
        server.sink.logBatches[before]?.resourceLogs[0]?.records,
      ).toHaveLength(2);
    });
  });

  describe("string caps", () => {
    it("cuts the body to 8,192 characters, the context and severity text too; NUL is made safe", () => {
      const batch = toIngestLogBatch(
        fromJsonRequest(
          logsJson([
            record({
              body: { stringValue: "b".repeat(20_000) },
              severityText: "S".repeat(500),
              severityNumber: 99,
              attributes: [
                {
                  key: "nestrix.log.context",
                  value: { stringValue: `c${"\u0000"}${"x".repeat(1000)}` },
                },
              ],
            }),
            record({ body: { stringValue: "a\u0000b" } }),
          ]),
        ),
      );
      const [first, second] = batch.resourceLogs[0]?.records ?? [];
      expect(first?.body).toHaveLength(8193);
      expect(first?.body.endsWith("…")).toBe(true);
      expect(first?.severityText).toHaveLength(64);
      expect(first?.severityNumber).toBe(0);
      expect(first?.context).toHaveLength(256);
      expect(first?.context).not.toContain("\u0000");
      expect(second?.body).toBe("a�b");
    });
  });

  describe("limits (bombs and oversize)", () => {
    it("a gzip bomb is cut off while inflating: 413", async () => {
      const bomb = gzipSync(Buffer.alloc(80 * MIB));
      const res = await send(bomb, {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "gzip",
      });
      expect(res.status).toBe(413);
      expect(await statusMessage(res)).toMatch(/after decompression/);
      await expectAlive();
    });

    it("8M empty log records gzipped to ~32 KiB are refused by the record cap before decoding: 413", async () => {
      const body = inScopeLogs(repeat([0x12, 0x00], 8 * MIB));
      const gz = gzipSync(body);
      expect(gz.length).toBeLessThan(128 * 1024);
      const heapBefore = process.memoryUsage().heapUsed;
      const res = await send(gz, {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "gzip",
      });
      expect(res.status).toBe(413);
      expect(await statusMessage(res)).toMatch(/more than 100000 log records/);
      expect((process.memoryUsage().heapUsed - heapBefore) / MIB).toBeLessThan(
        200,
      );
      await expectAlive();
    });

    it("empty resource logs are refused by the message cap: 413", async () => {
      const res = await send(gzipSync(repeat([0x0a, 0x00], 8 * MIB)), {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "gzip",
      });
      expect(res.status).toBe(413);
      expect(await statusMessage(res)).toMatch(
        /more than 400000 protobuf messages/,
      );
    });

    it("JSON: 150 000 log records (under the object cap) are refused by the record cap: 413", async () => {
      const records = Array.from({ length: 150_000 }, () => ({}));
      const res = await send(
        gzipSync(JSON.stringify(logsJson(records as JsonRecord[]))),
        {
          ...auth(),
          "content-type": JSON_TYPE,
          "content-encoding": "gzip",
        },
      );
      expect(res.status).toBe(413);
      expect(await statusMessage(res)).toMatch(/more than 100000 log records/);
    });

    it("JSON: 5M empty objects are refused before JSON.parse: 413", async () => {
      const body = `{"x":[${"{},".repeat(5_000_000)}{}]}`;
      const res = await send(gzipSync(body), {
        ...auth(),
        "content-type": JSON_TYPE,
        "content-encoding": "gzip",
      });
      expect(res.status).toBe(413);
      expect(await statusMessage(res)).toMatch(/JSON objects/);
    });

    it("refuses a declared length over the limit without reading: 413 and close", async () => {
      const res = await new Promise<{ status: number; connection: unknown }>(
        (resolve, reject) => {
          const req = httpRequest(
            logsUrl,
            {
              method: "POST",
              headers: {
                ...auth(),
                "content-type": PROTO,
                "content-length": 65 * MIB,
              },
            },
            (r) => {
              r.resume();
              r.on("end", () =>
                resolve({
                  status: r.statusCode ?? 0,
                  connection: r.headers.connection,
                }),
              );
            },
          );
          req.on("error", reject);
          req.write(Buffer.alloc(1024));
        },
      );
      expect(res.status).toBe(413);
      expect(res.connection).toBe("close");
      await expectAlive();
    });

    it("releases every byte it charged to the memory budget, whatever the outcome", () => {
      const receiver = server.app.get(IngestReceiver);
      expect(receiver.budget.inUse).toBe(0);
    });
  });

  describe("auth and media types", () => {
    it("answers 401 without a key or with a wrong one (OTLP Status, not the admin login)", async () => {
      const variants: Record<string, string>[] = [
        {},
        { authorization: "Bearer not-the-key" },
        { "x-nestrix-key": "not-the-key" },
        { authorization: `Basic ${OTHER_KEY}` },
      ];
      for (const headers of variants) {
        const res = await send(JSON.stringify(logsJson([record()])), {
          ...headers,
          "content-type": JSON_TYPE,
        });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe(
          'Bearer realm="nestrix-ingest"',
        );
        expect(await statusMessage(res)).toMatch(/API key/);
      }
    });

    it("rejects an unsupported Content-Type or Content-Encoding: 415", async () => {
      const a = await send("x", { ...auth(), "content-type": "text/plain" });
      expect(a.status).toBe(415);
      const b = await send(protoBody(), {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "br",
      });
      expect(b.status).toBe(415);
    });

    it("emits no CORS headers, even to a cross-site request", async () => {
      const res = await send(JSON.stringify(logsJson([record()])), {
        ...auth(),
        "content-type": JSON_TYPE,
        origin: "http://evil.example",
        "sec-fetch-site": "cross-site",
      });
      expect(res.status).toBe(200);
      expect(
        [...res.headers.keys()].filter((k) => k.startsWith("access-control-")),
      ).toEqual([]);
    });
  });

  describe("malformed bodies answer 400 and never crash", () => {
    it("truncated protobuf", async () => {
      const full = Buffer.from(protoBody());
      const statuses = new Set<number>();
      for (let n = 1; n < full.length; n += 5) {
        const res = await send(full.subarray(0, n), {
          ...auth(),
          "content-type": PROTO,
        });
        statuses.add(res.status);
        await res.arrayBuffer();
      }
      expect([...statuses].every((s) => s === 400 || s === 200)).toBe(true);
      expect(statuses.has(400)).toBe(true);
      await expectAlive();
    });

    it("invalid JSON, a non-object, wrong field types, deep nesting", async () => {
      const bodies = [
        "{not json",
        "[]",
        "null",
        JSON.stringify({ resourceLogs: "x" }),
        JSON.stringify(logsJson([record({ timeUnixNano: "soon" })])),
        // Lone surrogates never reach the mapper: the JSON reader refuses them.
        JSON.stringify(
          logsJson([record({ body: { stringValue: "a\uD800b" } })]),
        ),
        JSON.stringify(logsJson([record({ traceId: 7 as unknown as string })])),
        `${"[".repeat(5000)}${"]".repeat(5000)}`,
      ];
      for (const body of bodies) {
        const res = await send(body, { ...auth(), "content-type": JSON_TYPE });
        expect(res.status, body.slice(0, 40)).toBe(400);
        expect(await statusMessage(res)).toMatch(
          /ExportLogsServiceRequest|JSON object|nested/,
        );
      }
      await expectAlive();
    });
  });

  describe("sink failures", () => {
    it("503 with Retry-After on IngestBusyError and on any other failure", async () => {
      try {
        server.sink.logBehaviour = async () => {
          throw new IngestBusyError(9);
        };
        const busy = await send(JSON.stringify(logsJson([record()])), {
          ...auth(),
          "content-type": JSON_TYPE,
        });
        expect(busy.status).toBe(503);
        expect(busy.headers.get("retry-after")).toBe("9");
        for (const failure of [
          async () => {
            throw new Error("db down");
          },
          () => {
            throw "sync, not an Error";
          },
        ]) {
          server.sink.logBehaviour = failure as () => Promise<void>;
          const res = await send(JSON.stringify(logsJson([record()])), {
            ...auth(),
            "content-type": JSON_TYPE,
          });
          expect(res.status).toBe(503);
          expect(res.headers.get("retry-after")).toBe("5");
          expect(await statusMessage(res)).toMatch(
            /log records could not be stored/,
          );
        }
      } finally {
        server.sink.logBehaviour = async () => {};
      }
      await expectAlive();
    });
  });
});

describe("POST /v1/logs shares the rate limit with /v1/traces", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(
      testConfig({}, { rateLimit: { requestsPerSecond: 0.001, burst: 1 } }),
    );
  });
  afterAll(async () => {
    await server?.close();
  });

  it("a key that spent its burst on traces gets 429 on logs", async () => {
    const first = await post(server.url, "{}", {
      ...auth(),
      "content-type": JSON_TYPE,
    });
    expect(first.status).toBe(200);
    const res = await post(`${server.baseUrl}/v1/logs`, "{}", {
      ...auth(),
      "content-type": JSON_TYPE,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("a sink without writeLogs", () => {
  it("MemoryIngestSink counts log records and keeps nothing", async () => {
    const sink = new MemoryIngestSink();
    await sink.writeLogs(
      toIngestLogBatch(fromJsonRequest(logsJson([record(), record()]))),
    );
    expect(sink.logRecords).toBe(2);
  });
});

/** The JSON decoding path, without HTTP. */
function fromJsonRequest(body: unknown) {
  return decodeLogsRequest(Buffer.from(JSON.stringify(body)), "json", {
    maxSpans: 100_000,
    maxMessages: 400_000,
    maxJsonTokens: 1_200_000,
    maxDepth: 64,
  });
}
