// D-116: the in-flight memory budget charges a multi-chunk body twice (the chunks, then the
// joined copy reserved before it is made), releases every reservation on every path, and is
// never exceeded by what it charges.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { toBinary } from "@bufbuild/protobuf";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BodyError, ClientGoneError, readBody } from "../../src/ingest/body.js";
import { checkBody, decodeRequest } from "../../src/ingest/decode.js";
import { decodeCharge } from "../../src/ingest/limits.js";
import { IngestReceiver } from "../../src/ingest/receiver.js";
import { ExportTraceServiceRequestSchema } from "../../src/proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import {
  auth,
  fixture,
  PROTO,
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sends a raw HTTP request with the body in `pieces` writes, a pause between each, so the server
 * reads it as several chunks. With `abortAfter`, destroys the socket after that many pieces.
 * Resolves with the status (0 when the connection ended without a response).
 */
function sendInPieces(
  port: number,
  path: string,
  body: Buffer,
  headers: Record<string, string>,
  pieces: number,
  abortAfter?: number,
): Promise<number> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.setNoDelay(true);
    let response = "";
    let done = false;
    const finish = (status: number) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(status);
    };
    socket.on("data", (d) => {
      response += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(response);
      if (m && response.includes("\r\n\r\n")) finish(Number(m[1]));
    });
    socket.on("error", () => finish(0));
    socket.on("close", () => finish(0));
    socket.on("connect", async () => {
      const head = Object.entries({
        host: "127.0.0.1",
        "content-length": String(body.length),
        connection: "close",
        ...headers,
      })
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.write(`POST ${path} HTTP/1.1\r\n${head}\r\n`);
      const size = Math.ceil(body.length / pieces);
      for (let i = 0; i < pieces && !done; i++) {
        if (abortAfter !== undefined && i === abortAfter) {
          await sleep(20);
          finish(0);
          return;
        }
        socket.write(body.subarray(i * size, (i + 1) * size));
        await sleep(5);
      }
    });
  });
}

describe("readBody charges", () => {
  let server: Server;
  let port: number;
  let handler: (req: IncomingMessage) => Promise<unknown>;
  let outcome: Promise<unknown>;
  beforeAll(async () => {
    server = createServer((req, res) => {
      outcome = handler(req).then(
        (v) => v,
        (e) => e,
      );
      outcome.then(() => res.end("done"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function recording(
    allow: (total: number, bytes: number) => boolean = () => true,
  ) {
    const calls: number[] = [];
    let total = 0;
    return {
      calls,
      get total() {
        return total;
      },
      reserve: (bytes: number) => {
        if (!allow(total, bytes)) return false;
        calls.push(bytes);
        total += bytes;
        return true;
      },
    };
  }

  const body = Buffer.alloc(256 * 1024, 7);

  it("charges a body of several chunks twice: the chunks, then the join before it is made", async () => {
    const r = recording();
    handler = (req) => readBody(req, "identity", 1024 * 1024, r.reserve);
    await sendInPieces(port, "/", body, {}, 8);
    const result = (await outcome) as Buffer;
    expect(Buffer.compare(result, body)).toBe(0);
    expect(r.calls.length).toBeGreaterThan(2);
    // The last reservation is the join, the whole body at once.
    expect(r.calls.at(-1)).toBe(body.length);
    expect(r.total).toBe(2 * body.length);
  });

  it("charges a gzip body twice its inflated size", async () => {
    const r = recording();
    handler = (req) => readBody(req, "gzip", 1024 * 1024, r.reserve);
    await sendInPieces(port, "/", gzipSync(body), {}, 4);
    const result = (await outcome) as Buffer;
    expect(Buffer.compare(result, body)).toBe(0);
    expect(r.calls.at(-1)).toBe(body.length);
    expect(r.total).toBe(2 * body.length);
  });

  it("charges a body of one chunk once", async () => {
    const r = recording();
    const small = Buffer.alloc(1000, 1);
    handler = (req) => readBody(req, "identity", 1024 * 1024, r.reserve);
    await sendInPieces(port, "/", small, {}, 1);
    expect(Buffer.compare((await outcome) as Buffer, small)).toBe(0);
    expect(r.total).toBe(small.length);
  });

  it("answers 503 when the join does not fit, after taking only the chunks", async () => {
    // Every chunk fits; the join (a whole-body reservation) does not.
    const r = recording((_total, bytes) => bytes < body.length);
    handler = (req) => readBody(req, "identity", 1024 * 1024, r.reserve);
    await sendInPieces(port, "/", body, {}, 8);
    const error = await outcome;
    expect(error).toBeInstanceOf(BodyError);
    expect((error as BodyError).status).toBe(503);
    expect(r.total).toBe(body.length);
  });

  it("answers 503, without throwing out of the stream handler, when the join fails to allocate", async () => {
    const original = Buffer.concat;
    vi.spyOn(Buffer, "concat").mockImplementation((list, total) => {
      if (total === body.length)
        throw new RangeError("Array buffer allocation failed");
      return original(list, total);
    });
    const r = recording();
    handler = (req) => readBody(req, "identity", 1024 * 1024, r.reserve);
    await sendInPieces(port, "/", body, {}, 8);
    const error = await outcome;
    expect(error).toBeInstanceOf(BodyError);
    expect((error as BodyError).status).toBe(503);
    // The join was reserved; the caller releases it with the rest.
    expect(r.total).toBe(2 * body.length);
  });

  it("rejects with ClientGoneError when the client aborts mid-body", async () => {
    const r = recording();
    handler = (req) => readBody(req, "identity", 1024 * 1024, r.reserve);
    await sendInPieces(port, "/", body, {}, 8, 3);
    expect(await outcome).toBeInstanceOf(ClientGoneError);
    expect(r.total).toBeLessThan(body.length);
  });
});

describe("receiver budget across outcomes", () => {
  const body = fixture("traces.pb");
  const oneRequest =
    2 * body.length + decodeCharge(checkBody(body, "protobuf", LIMITS));
  let server: TestServer;
  let port: number;
  let receiver: IngestReceiver;
  let peak = 0;
  beforeAll(async () => {
    // Room for two requests of the fixture at once, not three.
    server = await startServer(
      testConfig({}, { inflightBudgetBytes: Math.floor(oneRequest * 2.5) }),
    );
    port = Number(new URL(server.url).port);
    receiver = server.app.get(IngestReceiver);
    const take = receiver.budget.tryTake.bind(receiver.budget);
    receiver.budget.tryTake = (bytes: number) => {
      const ok = take(bytes);
      peak = Math.max(peak, receiver.budget.inUse);
      return ok;
    };
  });
  afterAll(async () => {
    await server?.close();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    server.sink.behaviour = async () => {};
    // The receiver releases in a finally after answering; give it a turn.
    for (let i = 0; i < 50 && receiver.budget.inUse !== 0; i++) await sleep(10);
    expect(receiver.budget.inUse).toBe(0);
  });

  const headers = { ...auth(), "content-type": PROTO };

  it("charges a multi-chunk request twice its body plus the decode estimate, then releases it", async () => {
    let seen = 0;
    server.sink.behaviour = async () => {
      seen = receiver.budget.inUse;
    };
    expect(await sendInPieces(port, "/v1/traces", body, headers, 6)).toBe(200);
    expect(seen).toBe(oneRequest);
  });

  it("releases after an aborted body", async () => {
    await sendInPieces(port, "/v1/traces", body, headers, 6, 3);
  });

  it("releases after a gzip error", async () => {
    const broken = gzipSync(body);
    broken.fill(0, 20, 60);
    const status = await sendInPieces(
      port,
      "/v1/traces",
      broken,
      { ...headers, "content-encoding": "gzip" },
      4,
    );
    expect(status).toBe(400);
  });

  it("releases after a decode error", async () => {
    const truncated = Buffer.concat([body, Buffer.from([0x0a, 0x7f])]);
    expect(await sendInPieces(port, "/v1/traces", truncated, headers, 6)).toBe(
      400,
    );
  });

  it("releases after a sink failure and after a client that leaves while the sink works", async () => {
    server.sink.behaviour = async () => {
      throw new Error("storage down");
    };
    expect(await sendInPieces(port, "/v1/traces", body, headers, 6)).toBe(503);
    let release!: () => void;
    server.sink.behaviour = () => new Promise<void>((r) => (release = r));
    const gone = sendInPieces(port, "/v1/traces", body, headers, 6);
    for (let i = 0; i < 100 && release === undefined; i++) await sleep(10);
    // The client is gone before the sink answers.
    server.app.getHttpServer().closeAllConnections();
    await gone;
    release();
  });

  it("releases after a join that fails to allocate (503)", async () => {
    const original = Buffer.concat;
    vi.spyOn(Buffer, "concat").mockImplementation((list, total) => {
      if (total === body.length)
        throw new RangeError("Array buffer allocation failed");
      return original(list, total);
    });
    expect(await sendInPieces(port, "/v1/traces", body, headers, 6)).toBe(503);
  });

  it("never charges more than its capacity under concurrent multi-chunk requests, and answers 503 beyond it", async () => {
    peak = 0;
    server.sink.behaviour = () => sleep(30);
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        sendInPieces(port, "/v1/traces", body, headers, 6),
      ),
    );
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
    expect(statuses).toContain(503);
    // More than one request's charge was held at once, so the requests did overlap (the 503
    // above is what shows the capacity held).
    expect(peak).toBeGreaterThan(oneRequest);
  });
});

describe("decode estimate includes decoded strings (D-116)", () => {
  it("protobuf: charges the wire bytes of string fields, not bytes fields", () => {
    const value = "v".repeat(10_000);
    const attr = (v: string) => ({ key: "k", value: { stringValue: v } });
    const json = (v: string) =>
      Buffer.from(
        JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: "5b8efff798038103d269b633813fc60c",
                      spanId: "eee19b7ec3c1b174",
                      name: "n",
                      attributes: [attr(v)],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
    const small = checkBody(fixtureProtobuf(json("v")), "protobuf", LIMITS);
    const large = checkBody(fixtureProtobuf(json(value)), "protobuf", LIMITS);
    expect((large.textBytes ?? 0) - (small.textBytes ?? 0)).toBe(
      value.length - 1,
    );
    expect(decodeCharge(large) - decodeCharge(small)).toBe(value.length - 1);
    // Ids are bytes fields (views of the body): not charged as text.
    expect(small.textBytes).toBe("n".length + "k".length + "v".length);
  });

  it("JSON: charges twice the body (the text, then the strings parsed from it)", () => {
    const body = fixture("traces.json");
    const cost = checkBody(body, "json", LIMITS);
    expect(cost.textBytes).toBe(2 * body.length);
  });
});

function fixtureProtobuf(json: Buffer): Buffer {
  const request = decodeRequest(json, "json", LIMITS);
  return Buffer.from(toBinary(ExportTraceServiceRequestSchema, request));
}
