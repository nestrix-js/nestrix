// Review fixes for P5-01: decoded-object amplification, the in-flight memory budget, time
// bounds, slow clients, the memory sink and per-span caps.
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIB } from "../../src/config.js";
import { checkBody, decodeRequest } from "../../src/ingest/decode.js";
import { decodeCharge } from "../../src/ingest/limits.js";
import {
  DROPPED_ATTRIBUTES,
  DROPPED_EVENTS,
  DROPPED_LINKS,
  MAX_STRING_LENGTH,
  toIngestBatch,
} from "../../src/ingest/map.js";
import { MemoryIngestSink } from "../../src/ingest/memory-sink.js";
import { IngestReceiver } from "../../src/ingest/receiver.js";
import { deriveResource, deriveSpan } from "../../src/storage/derive.js";
import {
  auth,
  fixture,
  JSON_TYPE,
  PROTO,
  post,
  startServer,
  type TestServer,
  testConfig,
} from "./helpers.js";

const LIMITS = {
  maxSpans: 100_000,
  maxMessages: 400_000,
  maxJsonTokens: 1_200_000,
  maxDepth: 64,
};

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
/** `n` copies of `pair` (two or three bytes). */
function repeat(pair: number[], n: number): Buffer {
  const out = Buffer.alloc(pair.length * n);
  for (let i = 0; i < n; i++) out.set(pair, i * pair.length);
  return out;
}
/** ExportTraceServiceRequest{ resource_spans{ scope_spans{ <scopeContent> } } } */
function inScopeSpans(scopeContent: Buffer): Buffer {
  return field(0x0a, field(0x12, scopeContent));
}

async function message(res: Response): Promise<string> {
  const type = res.headers.get("content-type");
  if (type === JSON_TYPE) return (await res.json()).message;
  return Buffer.from(await res.arrayBuffer()).toString("latin1");
}

async function expectAlive(server: TestServer) {
  const res = await post(server.url, fixture("traces.pb"), {
    ...auth(),
    "content-type": PROTO,
  });
  expect(res.status).toBe(200);
}

describe("decoded-object amplification", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(
      testConfig({}, { rateLimit: { requestsPerSecond: 1e6, burst: 1e6 } }),
    );
  });
  afterAll(async () => {
    await server?.close();
  });

  async function send(body: Buffer, type: string, gzip = true) {
    const heapBefore = process.memoryUsage().heapUsed;
    const res = await post(server.url, gzip ? gzipSync(body) : body, {
      ...auth(),
      "content-type": type,
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    const text = await message(res);
    const grewMiB = (process.memoryUsage().heapUsed - heapBefore) / MIB;
    return { status: res.status, text, grewMiB };
  }

  it("the reviewer's bomb: 64 MiB of empty spans gzipped to ~64 KiB is 413, not an OOM", async () => {
    const body = inScopeSpans(repeat([0x12, 0x00], 32 * MIB));
    const gz = gzipSync(body);
    expect(gz.length).toBeLessThan(128 * 1024);
    const r = await send(body, PROTO);
    expect(r.status).toBe(413);
    await expectAlive(server);
  });

  it("8M empty spans within the size limit (16 MiB) are refused by the span cap before decoding", async () => {
    const r = await send(inScopeSpans(repeat([0x12, 0x00], 8 * MIB)), PROTO);
    expect(r.status).toBe(413);
    expect(r.text).toMatch(/more than 100000 spans/);
    expect(r.grewMiB).toBeLessThan(200); // decoding it took ~2.2 GB before the fix
    await expectAlive(server);
  });

  it("empty resource spans are refused by the message cap", async () => {
    const r = await send(repeat([0x0a, 0x00], 8 * MIB), PROTO);
    expect(r.status).toBe(413);
    expect(r.text).toMatch(/more than 400000 protobuf messages/);
    await expectAlive(server);
  });

  it("150 000 spans (under the message cap) are refused by the span cap", async () => {
    const r = await send(
      inScopeSpans(repeat([0x12, 0x00], 150_000)),
      PROTO,
      false,
    );
    expect(r.status).toBe(413);
    expect(r.text).toMatch(/more than 100000 spans/);
  });

  it("unknown fields are skipped, not kept as objects", async () => {
    // 5M copies of an unknown varint field (number 31) in the request: 15 MiB.
    const r = await send(repeat([0xf8, 0x01, 0x00], 5 * MIB), PROTO);
    expect(r.status).toBe(200);
    expect(r.grewMiB).toBeLessThan(200);
  });

  it("JSON: 5M empty span objects are refused before JSON.parse", async () => {
    const n = 5 * MIB;
    const body = Buffer.from(
      `{"resourceSpans":[{"scopeSpans":[{"spans":[${"{},".repeat(n - 1)}{}]}]}]}`,
    );
    const r = await send(body, JSON_TYPE);
    expect(r.status).toBe(413);
    expect(r.text).toMatch(/more than 400000 JSON objects/);
    expect(r.grewMiB).toBeLessThan(200);
    await expectAlive(server);
  });

  it("JSON: millions of empty arrays in an unknown field are refused", async () => {
    const body = Buffer.from(`{"x":[${"[],".repeat(3 * MIB)}[]]}`);
    const r = await send(body, JSON_TYPE);
    expect(r.status).toBe(413);
    expect(r.text).toMatch(/JSON values/);
  });

  it("JSON: 150 000 spans (under the object cap) are refused by the span cap", async () => {
    const body = Buffer.from(
      `{"resourceSpans":[{"scopeSpans":[{"spans":[${"{},".repeat(149_999)}{}]}]}]}`,
    );
    const r = await send(body, JSON_TYPE, false);
    expect(r.status).toBe(413);
    expect(r.text).toMatch(/more than 100000 spans/);
  });

  it("releases everything it charged, whatever the outcome", async () => {
    const receiver = server.app.get(IngestReceiver);
    expect(receiver.budget.inUse).toBe(0);
  });
});

describe("in-flight memory budget", () => {
  const body = fixture("traces.pb");
  // What one fixture request is charged: its body plus the decoding estimate.
  const oneRequest =
    body.length + decodeCharge(checkBody(body, "protobuf", LIMITS));

  it("answers 503 with Retry-After while full, and recovers", async () => {
    const server = await startServer(
      testConfig({}, { inflightBudgetBytes: Math.floor(oneRequest * 1.5) }),
    );
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      server.sink.behaviour = () => held;
      const first = post(server.url, body, {
        ...auth(),
        "content-type": PROTO,
      });
      const receiver = server.app.get(IngestReceiver);
      for (let i = 0; i < 100 && receiver.budget.inUse < oneRequest; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(receiver.budget.inUse).toBe(oneRequest);

      const second = await post(server.url, body, {
        ...auth(),
        "content-type": PROTO,
      });
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBe("1");

      server.sink.behaviour = async () => {};
      release();
      expect((await first).status).toBe(200);
      expect(receiver.budget.inUse).toBe(0);
      const third = await post(server.url, body, {
        ...auth(),
        "content-type": PROTO,
      });
      expect(third.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("answers 413 to a request that could never fit", async () => {
    const server = await startServer(
      testConfig({}, { inflightBudgetBytes: Math.floor(oneRequest / 2) }),
    );
    try {
      const res = await post(server.url, body, {
        ...auth(),
        "content-type": PROTO,
      });
      expect(res.status).toBe(413);
      expect(server.app.get(IngestReceiver).budget.inUse).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("span times", () => {
  const NOW = 1_800_000_000_000_000_000n;
  function batchWith(start: string, end: string) {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "5b8efff798038103d269b633813fc60c",
                  spanId: "eee19b7ec3c1b174",
                  startTimeUnixNano: start,
                  endTimeUnixNano: end,
                },
              ],
            },
          ],
        },
      ],
    };
    return toIngestBatch(
      decodeRequest(Buffer.from(JSON.stringify(body)), "json", LIMITS),
      NOW,
    );
  }

  it("rejects times beyond int8 (end = 2^64 - 1)", () => {
    const b = batchWith(String(NOW), "18446744073709551615");
    expect(b.rejectedSpans).toBe(1);
    expect(b.errorMessage).toMatch(/time out of range/);
    expect(
      batchWith("9223372036854775808", "9223372036854775808").errorMessage,
    ).toMatch(/time out of range/);
  });

  it("rejects times more than a day ahead, accepts less", () => {
    const day = 86_400_000_000_000n;
    const late = batchWith(String(NOW), String(NOW + day + 1n));
    expect(late.errorMessage).toMatch(/more than a day in the future/);
    const startLate = batchWith(String(NOW + 2n * day), String(NOW + 2n * day));
    expect(startLate.rejectedSpans).toBe(1);
    expect(batchWith(String(NOW), String(NOW + day)).rejectedSpans).toBe(0);
  });

  it("storage refuses times beyond int8 and accepts the largest that fits", () => {
    const resource = deriveResource({ "service.name": "s" });
    const span = (end: bigint) => ({
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "eee19b7ec3c1b174",
      name: "n",
      kind: "internal" as const,
      startTimeUnixNano: 1n,
      endTimeUnixNano: end,
      attributes: {},
      events: [],
      links: [],
      status: { code: "unset" as const },
    });
    expect(deriveSpan(span(2n ** 63n), resource)).toBeNull();
    expect(deriveSpan(span(2n ** 63n - 1n), resource)).not.toBeNull();
  });
});

describe("slow clients", () => {
  it("applies the HTTP server limits", async () => {
    const server = await startServer(
      testConfig({ NESTRIX_MAX_CONNECTIONS: "77" }),
    );
    try {
      const http = server.app.getHttpServer();
      expect(http.requestTimeout).toBe(60_000);
      expect(http.headersTimeout).toBe(20_000);
      expect(http.maxConnections).toBe(77);
    } finally {
      await server.close();
    }
  });

  it("destroys a connection whose unread body does not arrive within the discard timeout", async () => {
    const server = await startServer(testConfig({}, { discardTimeoutMs: 200 }));
    try {
      const t0 = performance.now();
      const outcome = await new Promise<{
        status: number;
        closedAfterMs: number;
      }>((resolve, reject) => {
        let status = 0;
        const req = httpRequest(server.url, {
          method: "POST",
          headers: { "content-type": PROTO, "content-length": 1_000_000 },
        });
        req.on("response", (res) => {
          status = res.statusCode ?? 0;
          res.resume();
        });
        // The server ends the connection; the client sees close (and maybe a reset).
        req.on("error", () => {});
        req.on("close", () =>
          resolve({ status, closedAfterMs: performance.now() - t0 }),
        );
        req.write(Buffer.alloc(100)); // then nothing more
        setTimeout(() => reject(new Error("connection still open")), 5_000);
      });
      expect(outcome.status).toBe(401);
      expect(outcome.closedAfterMs).toBeGreaterThanOrEqual(150);
      expect(outcome.closedAfterMs).toBeLessThan(2_000);
    } finally {
      await server.close();
    }
  });
});

describe("MemoryIngestSink", () => {
  it("keeps counts only", async () => {
    const sink = new MemoryIngestSink();
    const batch = toIngestBatch(
      decodeRequest(fixture("traces.pb"), "protobuf", LIMITS),
    );
    for (let i = 0; i < 1000; i++) await sink.write(batch);
    expect(sink.batches).toBe(1000);
    expect(sink.spans).toBe(4000);
    const retained = Object.values(sink).filter((v) => Array.isArray(v));
    expect(retained).toEqual([]);
  });
});

describe("per-span caps", () => {
  function span(extra: Record<string, unknown>) {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "5b8efff798038103d269b633813fc60c",
                  spanId: "eee19b7ec3c1b174",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000000000001",
                  ...extra,
                },
              ],
            },
          ],
        },
      ],
    };
    const batch = toIngestBatch(
      decodeRequest(Buffer.from(JSON.stringify(body)), "json", LIMITS),
    );
    expect(batch.rejectedSpans).toBe(0);
    return batch.resourceSpans[0].spans[0];
  }
  const kv = (i: number) => ({ key: `k${i}`, value: { stringValue: "v" } });
  const link = (i: number) => ({
    traceId: "0102030405060708090a0b0c0d0e0f10",
    spanId: (i + 1).toString(16).padStart(16, "0"),
  });

  it("keeps 256 attributes and records the dropped count, including the sender's", () => {
    const s = span({
      attributes: Array.from({ length: 300 }, (_, i) => kv(i)),
      droppedAttributesCount: 5,
    });
    const keys = Object.keys(s.attributes);
    expect(keys).toHaveLength(257);
    expect(keys[255]).toBe("k255");
    expect(s.attributes[DROPPED_ATTRIBUTES]).toBe(44 + 5);
  });

  it("cuts long strings to 16 KiB", () => {
    const s = span({
      name: "n".repeat(40_000),
      attributes: [
        { key: "long", value: { stringValue: "x".repeat(40_000) } },
        {
          key: "kv",
          value: {
            kvlistValue: {
              values: [
                { key: "a", value: { stringValue: "y".repeat(40_000) } },
              ],
            },
          },
        },
      ],
    });
    expect(s.name).toHaveLength(MAX_STRING_LENGTH);
    expect(s.attributes.long).toHaveLength(MAX_STRING_LENGTH);
    expect((s.attributes.kv as string).length).toBeLessThanOrEqual(
      MAX_STRING_LENGTH,
    );
  });

  it("keeps 1000 events and 1000 links and records the rest", () => {
    const s = span({
      events: Array.from({ length: 1005 }, (_, i) => ({
        name: `e${i}`,
        timeUnixNano: "1700000000000000000",
      })),
      droppedEventsCount: 2,
      links: [
        ...Array.from({ length: 1003 }, (_, i) => link(i)),
        { traceId: "zz", spanId: "zz" },
      ],
    });
    expect(s.events).toHaveLength(1000);
    expect(s.attributes[DROPPED_EVENTS]).toBe(5 + 2);
    expect(s.links).toHaveLength(1000);
    expect(s.attributes[DROPPED_LINKS]).toBe(4);
  });

  it("records nothing when nothing was dropped", () => {
    const s = span({ attributes: [kv(1)] });
    expect(Object.keys(s.attributes)).toEqual(["k1"]);
  });
});
