// Unhappy paths of POST /v1/traces: partial success, limits, encodings, auth, back-pressure and
// malformed bodies. Vitest fails the run on any unhandled error, so "never crashes" is checked
// by every test, and each block ends by showing the server still answers.

import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIB } from "../../src/config.js";
import { IngestBusyError } from "../../src/ingest/model.js";
import { StatusSchema } from "../../src/proto/gen/google/rpc/status_pb.js";
import {
  ExportTraceServiceRequestSchema,
  ExportTraceServiceResponseSchema,
} from "../../src/proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import {
  auth,
  fixture,
  JSON_TYPE,
  OTHER_KEY,
  PROTO,
  post,
  startServer,
  type TestServer,
  testConfig,
} from "./helpers.js";

const json = () => JSON.parse(fixture("traces.json").toString("utf8"));

async function statusMessage(res: Response): Promise<string> {
  const type = res.headers.get("content-type");
  if (type === PROTO) {
    return fromBinary(StatusSchema, new Uint8Array(await res.arrayBuffer()))
      .message;
  }
  expect(type).toBe(JSON_TYPE);
  return (await res.json()).message;
}

async function expectAlive(server: TestServer) {
  const res = await post(server.url, fixture("traces.pb"), {
    ...auth(),
    "content-type": PROTO,
  });
  expect(res.status).toBe(200);
}

/** Raw request, for bodies fetch cannot send (lying lengths, chunked streams, aborts). */
function raw(
  url: string,
  headers: Record<string, string | number>,
  write: (req: ReturnType<typeof httpRequest>) => void,
  options: { waitForUpload?: boolean; tolerateReset?: boolean } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let response:
      | { status: number; headers: Record<string, unknown>; body: Buffer }
      | undefined;
    // With waitForUpload, resolve only once the whole body has also been written: a server
    // that stops reading without closing leaves the upload stalled and the test times out.
    let uploaded = !options.waitForUpload;
    const done = () => {
      if (response && uploaded) resolve(response);
    };
    let sawResponse = false;
    const req = httpRequest(url, { method: "POST", headers }, (res) => {
      sawResponse = true;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      // A server that answers 413 from the headers and closes (`Connection: close`) may reset
      // the socket while the client is still writing; what matters is the status it sent.
      if (options.tolerateReset) {
        const head = () => {
          response ??= {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          };
          uploaded = true;
          done();
        };
        res.on("error", head);
        res.on("aborted", head);
      }
      res.on("end", () => {
        response = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        };
        done();
      });
    });
    req.on("finish", () => {
      uploaded = true;
      done();
    });
    req.on("error", (error) => {
      // After the response arrived, the reset of the unfinished upload is expected.
      if (options.tolerateReset && sawResponse) return;
      reject(error);
    });
    write(req);
  });
}

describe("receiver with API keys", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(
      // Default limits (20 MiB body); only the rate limit is out of the way.
      testConfig({}, { rateLimit: { requestsPerSecond: 1e6, burst: 1e6 } }),
    );
  });
  afterAll(async () => {
    await server?.close();
  });

  describe("partial success", () => {
    it("rejects invalid spans individually (JSON)", async () => {
      const body = json();
      const spans = body.resourceSpans[0].scopeSpans[0].spans;
      spans[0].spanId = "zz"; // not hex
      spans[1].endTimeUnixNano = "1"; // before its start
      spans[2].traceId = "00000000000000000000000000000000"; // all zero
      const before = server.sink.batches.length;
      const res = await post(server.url, JSON.stringify(body), {
        ...auth(),
        "content-type": JSON_TYPE,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(JSON_TYPE);
      const answer = await res.json();
      expect(answer.partialSuccess.rejectedSpans).toBe("3");
      expect(answer.partialSuccess.errorMessage).toBe(
        "Rejected 3 of 4 spans: invalid span id (1), end time before start time (1), invalid trace id (1).",
      );
      const batch = server.sink.batches[before];
      expect(batch.rejectedSpans).toBe(3);
      expect(batch.resourceSpans[0].spans).toHaveLength(1);
    });

    it("rejects invalid spans individually (protobuf)", async () => {
      const request = fromBinary(
        ExportTraceServiceRequestSchema,
        fixture("traces.pb"),
      );
      const spans = request.resourceSpans[0].scopeSpans[0].spans;
      spans[0].spanId = new Uint8Array(4);
      spans[1].parentSpanId = new Uint8Array(3);
      spans[2].startTimeUnixNano = 0n;
      spans[2].endTimeUnixNano = 0n;
      const res = await post(
        server.url,
        toBinary(ExportTraceServiceRequestSchema, request),
        { ...auth(), "content-type": PROTO },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(PROTO);
      const answer = fromBinary(
        ExportTraceServiceResponseSchema,
        new Uint8Array(await res.arrayBuffer()),
      );
      expect(answer.partialSuccess?.rejectedSpans).toBe(3n);
      expect(answer.partialSuccess?.errorMessage).toMatch(
        /invalid span id \(1\).*invalid parent span id \(1\).*missing start time \(1\)/,
      );
    });

    it("reports spans the sink did not store over the per-trace cap as rejected, after the invalid ones", async () => {
      const body = json();
      const spans = body.resourceSpans[0].scopeSpans[0].spans;
      spans[0].spanId = "zz"; // invalid: rejected by the receiver
      server.sink.result = { droppedSpans: 2 };
      try {
        const res = await post(server.url, JSON.stringify(body), {
          ...auth(),
          "content-type": JSON_TYPE,
        });
        expect(res.status).toBe(200);
        const answer = await res.json();
        expect(answer.partialSuccess.rejectedSpans).toBe("3");
        expect(answer.partialSuccess.errorMessage).toBe(
          "Rejected 1 of 4 spans: invalid span id (1). 2 spans not stored: their trace is over the per-trace span limit (NESTRIX_MAX_SPANS_PER_TRACE).",
        );
      } finally {
        server.sink.result = undefined;
      }
    });

    it("answers a plain success when the cap dropped nothing", async () => {
      server.sink.result = { droppedSpans: 0 };
      try {
        const res = await post(server.url, JSON.stringify(json()), {
          ...auth(),
          "content-type": JSON_TYPE,
        });
        expect((await res.json()).partialSuccess).toBeUndefined();
      } finally {
        server.sink.result = undefined;
      }
    });

    it("answers 200 with every span rejected, without calling the sink", async () => {
      const body = json();
      for (const s of body.resourceSpans[0].scopeSpans[0].spans) s.spanId = "";
      const before = server.sink.batches.length;
      const res = await post(server.url, JSON.stringify(body), {
        ...auth(),
        "content-type": JSON_TYPE,
      });
      expect(res.status).toBe(200);
      expect((await res.json()).partialSuccess.rejectedSpans).toBe("4");
      expect(server.sink.batches.length).toBe(before);
    });

    it("answers an empty request with full success", async () => {
      const before = server.sink.batches.length;
      const a = await post(server.url, "{}", {
        ...auth(),
        "content-type": JSON_TYPE,
      });
      expect(a.status).toBe(200);
      expect(await a.text()).toBe("{}");
      const b = await post(server.url, new Uint8Array(0), {
        ...auth(),
        "content-type": PROTO,
      });
      expect(b.status).toBe(200);
      expect((await b.arrayBuffer()).byteLength).toBe(0);
      expect(server.sink.batches.length).toBe(before);
    });

    it("drops a link with an invalid id but keeps its span", async () => {
      const body = json();
      const span = body.resourceSpans[0].scopeSpans[0].spans.find(
        (s: { links: unknown[] }) => s.links.length > 0,
      );
      span.links[0].spanId = "abc";
      const before = server.sink.batches.length;
      const res = await post(server.url, JSON.stringify(body), {
        ...auth(),
        "content-type": JSON_TYPE,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("{}");
      const stored = server.sink.batches[before].resourceSpans[0].spans.find(
        (s) => s.spanId === span.spanId,
      );
      expect(stored?.links).toEqual([]);
    });
  });

  describe("limits", () => {
    it("cuts a gzip bomb off while inflating: 413", async () => {
      const bomb = gzipSync(Buffer.alloc(80 * MIB)); // ~80 KB compressed
      expect(bomb.length).toBeLessThan(MIB);
      const res = await post(server.url, bomb, {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "gzip",
      });
      expect(res.status).toBe(413);
      expect(await statusMessage(res)).toMatch(/after decompression/);
      await expectAlive(server);
    });

    it("refuses a declared length over the limit without reading: 413", async () => {
      const res = await raw(
        server.url,
        { ...auth(), "content-type": PROTO, "content-length": 65 * MIB },
        (req) => req.write(Buffer.alloc(1024)), // and never the rest
      );
      expect(res.status).toBe(413);
      expect(res.headers.connection).toBe("close");
      await expectAlive(server);
    });
  });

  describe("encodings and media types", () => {
    it("rejects an unsupported Content-Type: 415", async () => {
      for (const type of ["text/plain", "application/protobuf", ""]) {
        const res = await post(server.url, "x", {
          ...auth(),
          "content-type": type,
        });
        expect(res.status, type).toBe(415);
        expect(res.headers.get("content-type")).toBe(JSON_TYPE);
        expect(await statusMessage(res)).toMatch(/Content-Type/);
      }
    });

    it("accepts media type parameters", async () => {
      const res = await post(server.url, fixture("traces.json"), {
        ...auth(),
        "content-type": "application/json; charset=utf-8",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(JSON_TYPE);
    });

    it("rejects an unsupported Content-Encoding: 415", async () => {
      const res = await post(server.url, fixture("traces.pb"), {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "br",
      });
      expect(res.status).toBe(415);
      expect(res.headers.get("content-type")).toBe(PROTO);
      expect(await statusMessage(res)).toMatch(/Content-Encoding/);
    });

    it("accepts identity", async () => {
      const res = await post(server.url, fixture("traces.pb"), {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "identity",
      });
      expect(res.status).toBe(200);
    });

    it("rejects a body that is not gzip: 400", async () => {
      const res = await post(server.url, fixture("traces.pb"), {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "gzip",
      });
      expect(res.status).toBe(400);
      expect(await statusMessage(res)).toMatch(/gzip/);
    });

    it("leaves the ingest body to the receiver whatever the path's case or trailing slash", async () => {
      for (const path of ["/v1/traces/", "/V1/Traces"]) {
        const res = await post(
          `${server.baseUrl}${path}`,
          fixture("traces.json"),
          { ...auth(), "content-type": JSON_TYPE },
        );
        expect(res.status, path).toBe(200);
      }
    });
  });

  describe("auth", () => {
    it("answers 401 without a key", async () => {
      const res = await post(server.url, fixture("traces.pb"), {
        "content-type": PROTO,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect(await statusMessage(res)).toMatch(/missing API key/);
    });

    it("answers 401 with a wrong key, in either header", async () => {
      const variants: Record<string, string>[] = [
        { authorization: "Bearer not-the-key" },
        { "x-nestrix-key": "not-the-key" },
        { authorization: `Basic ${OTHER_KEY}` },
      ];
      for (const headers of variants) {
        const res = await post(server.url, fixture("traces.json"), {
          ...headers,
          "content-type": JSON_TYPE,
        });
        expect(res.status).toBe(401);
        expect(await statusMessage(res)).toMatch(/API key/);
      }
    });

    it("answers 401 to a client still sending a large body, instead of resetting it", async () => {
      const res = await raw(
        server.url,
        { "content-type": PROTO, "content-length": 3 * MIB },
        (req) => req.end(Buffer.alloc(3 * MIB)),
      );
      expect(res.status).toBe(401);
      expect(res.headers.connection).not.toBe("close");
      await expectAlive(server);
    });

    it("accepts any configured key in either header", async () => {
      for (const headers of [
        auth(),
        { authorization: `bearer ${OTHER_KEY}` },
        { "x-nestrix-key": OTHER_KEY },
      ]) {
        const res = await post(server.url, fixture("traces.pb"), {
          ...headers,
          "content-type": PROTO,
        });
        expect(res.status).toBe(200);
      }
    });
  });

  describe("sink failures", () => {
    it("answers 503 with Retry-After on IngestBusyError", async () => {
      server.sink.behaviour = async () => {
        throw new IngestBusyError(7);
      };
      try {
        const res = await post(server.url, fixture("traces.pb"), {
          ...auth(),
          "content-type": PROTO,
        });
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("7");
        expect(await statusMessage(res)).toMatch(/over capacity/);
      } finally {
        server.sink.behaviour = async () => {};
      }
    });

    it("answers 503 with Retry-After on any other sink failure, sync or async", async () => {
      const failures: Array<() => Promise<void>> = [
        async () => {
          throw new Error("connection refused");
        },
        () => {
          throw new Error("synchronous");
        },
        async () => {
          throw "not an error";
        },
      ];
      try {
        for (const failure of failures) {
          server.sink.behaviour = failure;
          const res = await post(server.url, fixture("traces.json"), {
            ...auth(),
            "content-type": JSON_TYPE,
          });
          expect(res.status).toBe(503);
          expect(res.headers.get("retry-after")).toBe("5");
        }
      } finally {
        server.sink.behaviour = async () => {};
      }
      await expectAlive(server);
    });
  });

  describe("malformed bodies answer 400 and never crash", () => {
    it("truncated protobuf", async () => {
      const full = fixture("traces.pb");
      const statuses = new Set<number>();
      for (let n = 1; n < full.length; n += 7) {
        const res = await post(server.url, full.subarray(0, n), {
          ...auth(),
          "content-type": PROTO,
        });
        statuses.add(res.status);
        await res.arrayBuffer();
      }
      // A cut on a field boundary is a valid, shorter message (some spans with partial success).
      expect([...statuses].every((s) => s === 200 || s === 400)).toBe(true);
      expect(statuses.has(400)).toBe(true);
      await expectAlive(server);
    });

    it("random bytes as protobuf", async () => {
      for (let i = 0; i < 50; i++) {
        const res = await post(server.url, randomBytes(64 + i * 13), {
          ...auth(),
          "content-type": PROTO,
        });
        expect([200, 400]).toContain(res.status);
        await res.arrayBuffer();
      }
      await expectAlive(server);
    });

    it("invalid UTF-8 in a protobuf string field", async () => {
      // ExportTraceServiceRequest{resource_spans{scope_spans{spans{name: 0xff 0xfe}}}}
      const span = Buffer.from([0x2a, 0x02, 0xff, 0xfe]); // field 5 (name), len 2
      const scopeSpans = Buffer.concat([
        Buffer.from([0x12, span.length]),
        span,
      ]);
      const resourceSpans = Buffer.concat([
        Buffer.from([0x12, scopeSpans.length]),
        scopeSpans,
      ]);
      const body = Buffer.concat([
        Buffer.from([0x0a, resourceSpans.length]),
        resourceSpans,
      ]);
      const res = await post(server.url, body, {
        ...auth(),
        "content-type": PROTO,
      });
      expect(res.status).toBe(400);
      expect(await statusMessage(res)).toMatch(/UTF-8/);
    });

    it("protobuf nested deeper than the limit", async () => {
      // AnyValue{kvlist_value{values{key:"k" value:AnyValue{...}}}} nested 2000 times.
      let inner: Buffer = Buffer.from([0x0a, 0x01, 0x76]); // AnyValue{string_value:"v"}
      for (let i = 0; i < 2000; i++) {
        const kv = Buffer.concat([
          Buffer.from([0x0a, 0x01, 0x6b]), // key "k"
          lengthDelimited(0x12, inner), // value
        ]);
        inner = lengthDelimited(0x32, lengthDelimited(0x0a, kv)); // kvlist_value{values}
      }
      const attribute = Buffer.concat([
        Buffer.from([0x0a, 0x01, 0x61]),
        lengthDelimited(0x12, inner),
      ]);
      const span = lengthDelimited(0x4a, attribute); // Span.attributes = 9
      const body = lengthDelimited(
        0x0a,
        lengthDelimited(0x12, lengthDelimited(0x12, span)),
      );
      const res = await post(server.url, body, {
        ...auth(),
        "content-type": PROTO,
      });
      expect(res.status).toBe(400);
      expect(await statusMessage(res)).toMatch(/recursion|nested/);
      await expectAlive(server);
    });

    it("JSON that is not JSON, not an object, or has wrong types", async () => {
      const bodies: string[] = [
        "not json",
        "",
        "[]",
        "null",
        "42",
        '{"resourceSpans":"x"}',
        '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":123}]}]}]}',
        '{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":{}}]}]}]}',
        '{"resourceSpans":[{"scopeSpans":[{"spans":[{"attributes":[{"key":"a","value":{"intValue":"1.5"}}]}]}]}]}',
        '{"resourceSpans":[{"scopeSpans":[{"spans":[{"endTimeUnixNano":"-1"}]}]}]}',
        JSON.stringify(json()).slice(0, 500),
      ];
      for (const body of bodies) {
        const res = await post(server.url, body, {
          ...auth(),
          "content-type": JSON_TYPE,
        });
        expect(res.status, body.slice(0, 80)).toBe(400);
        expect(await statusMessage(res)).toMatch(/JSON/);
      }
      await expectAlive(server);
    });

    it("an unknown enum name is ignored like an unknown field (the span is then judged on its own)", async () => {
      const body = json();
      const span = body.resourceSpans[0].scopeSpans[0].spans[0];
      span.kind = "SPAN_KIND_NOPE";
      span.status = { code: "STATUS_CODE_ERROR" };
      const before = server.sink.batches.length;
      const res = await post(server.url, JSON.stringify(body), {
        ...auth(),
        "content-type": JSON_TYPE,
      });
      expect(res.status).toBe(200);
      const stored = server.sink.batches[before].resourceSpans[0].spans.find(
        (s) => s.spanId === span.spanId,
      );
      expect(stored?.kind).toBe("internal");
      expect(stored?.status.code).toBe("error"); // enum names are accepted
    });

    it("deeply nested JSON", async () => {
      const depth = 100_000;
      const body = `{"resourceSpans":[{"scopeSpans":[{"spans":[{"attributes":[{"key":"a","value":${'{"arrayValue":{"values":['.repeat(depth)}${"]}}".repeat(depth)}}]}]}]}]}`;
      const res = await post(server.url, body, {
        ...auth(),
        "content-type": JSON_TYPE,
      });
      expect(res.status).toBe(400);
      await res.arrayBuffer();
      await expectAlive(server);
    });

    it("a client that aborts mid-body", async () => {
      await new Promise<void>((resolve) => {
        const req = httpRequest(server.url, {
          method: "POST",
          headers: {
            ...auth(),
            "content-type": PROTO,
            "content-length": 10_000,
          },
        });
        req.on("error", () => resolve());
        req.write(Buffer.alloc(100));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50);
      });
      await expectAlive(server);
    });
  });
});

function lengthDelimited(tag: number, payload: Buffer): Buffer {
  const length: number[] = [];
  let n = payload.length;
  while (n > 0x7f) {
    length.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  length.push(n);
  return Buffer.concat([Buffer.from([tag, ...length]), payload]);
}

describe("receiver with a small body limit", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(testConfig({}, { maxBodyBytes: MIB }));
  });
  afterAll(async () => {
    await server?.close();
  });

  it("cuts off a chunked body without a length once it passes the limit: 413", async () => {
    const res = await raw(
      server.url,
      { ...auth(), "content-type": PROTO, "transfer-encoding": "chunked" },
      (req) => {
        // Written without waiting for 'drain', as the OTLP exporters do (`req.end(body)`):
        // Node's client stops relaying 'drain' once the response has ended.
        for (let sent = 0; sent < 4 * MIB; sent += 64 * 1024) {
          req.write(Buffer.alloc(64 * 1024));
        }
        req.end();
      },
      // The upload must complete too: the server reads and discards the rest after its 413.
      { waitForUpload: true },
    );
    expect(res.status).toBe(413);
    await expectAlive(server);
  });

  it("refuses compressed bytes over the limit even when they inflate to less: 413", async () => {
    // Stored (level 0) gzip adds a few bytes per 64 KiB block: just over the limit compressed,
    // just under it inflated, so only the compressed-size check can refuse it.
    const incompressible = gzipSync(randomBytes(MIB - 8), { level: 0 });
    expect(incompressible.length).toBeGreaterThan(MIB);
    // Declared length over the limit: the server answers 413 and closes without reading, so
    // the client may see a reset after (or, rarely, instead of) the response; `raw` keeps it.
    const before = server.sink.batches.length;
    const res = await raw(
      server.url,
      {
        ...auth(),
        "content-type": PROTO,
        "content-encoding": "gzip",
        "content-length": incompressible.length,
      },
      (req) => req.end(incompressible),
      { tolerateReset: true },
    );
    expect(res.status).toBe(413);
    expect(server.sink.batches.length).toBe(before);
  });
});

describe("rate limit", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(
      testConfig({}, { rateLimit: { requestsPerSecond: 0.5, burst: 2 } }),
    );
  });
  afterAll(async () => {
    await server?.close();
  });

  it("answers 429 with Retry-After once a key's bucket is empty, per key", async () => {
    const send = (headers: Record<string, string>) =>
      post(server.url, fixture("traces.pb"), {
        ...headers,
        "content-type": PROTO,
      });
    expect((await send(auth())).status).toBe(200);
    expect((await send(auth())).status).toBe(200);
    const limited = await send(auth());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
    expect(await statusMessage(limited)).toMatch(/too many/);
    // Another key has its own bucket.
    expect((await send({ "x-nestrix-key": OTHER_KEY })).status).toBe(200);
  });
});

describe("auth opt-out and unconfigured", () => {
  it("NESTRIX_INGEST_AUTH=none accepts requests without a key", async () => {
    const server = await startServer(
      testConfig({ NESTRIX_INGEST_KEYS: "", NESTRIX_INGEST_AUTH: "none" }),
    );
    try {
      const res = await post(server.url, fixture("traces.pb"), {
        "content-type": PROTO,
      });
      expect(res.status).toBe(200);
      expect(server.sink.spans()).toHaveLength(4);
    } finally {
      await server.close();
    }
  });

  it("with neither keys nor the opt-out, every request gets 401", async () => {
    const server = await startServer(testConfig({ NESTRIX_INGEST_KEYS: "" }));
    try {
      const res = await post(server.url, fixture("traces.pb"), {
        ...auth(),
        "content-type": PROTO,
      });
      expect(res.status).toBe(401);
      expect(await statusMessage(res)).toMatch(/NESTRIX_INGEST_KEYS/);
      expect(server.sink.batches).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
