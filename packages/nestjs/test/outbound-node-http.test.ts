// node:http client spans (P1-08). Global state: a host-style provider with an in-memory exporter.
import http from "node:http";
import {
  context,
  createTraceState,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { installOutbound } from "../src/outbound/index.js";
import { setOutboundFaultForTests } from "../src/outbound/rules.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import {
  clientSpans,
  closedPort,
  type EchoServer,
  inParent,
  resolved,
  setupTestTracing,
  sleep,
  startEchoServer,
  suppressed,
  trackDoubleEnds,
  trackUncaught,
  unsampledParent,
  waitFor,
} from "./outbound-helpers.js";

const { exporter, provider } = setupTestTracing();
const doubleEnds = trackDoubleEnds();
let server: EchoServer;
let diagnostics = recordingDiagnostics();
let uninstall: () => void = () => undefined;

function install(options: Parameters<typeof resolved>[0] = {}): void {
  uninstall();
  diagnostics = recordingDiagnostics();
  uninstall = installOutbound(resolved(options), diagnostics);
}

beforeAll(async () => {
  server = await startEchoServer();
});
afterAll(async () => {
  uninstall();
  await server.close();
  await provider.shutdown();
});
beforeEach(() => {
  install();
  exporter.reset();
  server.received.length = 0;
});
afterEach(() => {
  setOutboundFaultForTests(undefined);
  // No span in any test is ended twice (the SDK would ignore the second end silently).
  expect(doubleEnds).toEqual([]);
});

interface Outcome {
  status?: number;
  body?: string;
  error?: string;
}

/** `http.get` that reads the whole body. */
function get(url: string, options: http.RequestOptions = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const req = http.get(url, options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", (e) =>
        resolve({ status: res.statusCode, error: e.message }),
      );
    });
    req.on("error", (e: NodeJS.ErrnoException) =>
      resolve({ error: e.code ?? e.message }),
    );
  });
}

const tp = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;

describe("node:http client span", () => {
  it("is a child of the active span and sends its traceparent (GET /out via http.get)", async () => {
    const { parent, result } = await inParent(() =>
      get(`${server.base}/ok?x=1`),
    );
    expect(result).toEqual({ status: 200, body: "ok" });
    await waitFor(() => clientSpans(exporter).length === 1);
    const [span] = clientSpans(exporter);
    expect(span?.name).toBe("GET");
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span?.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(span?.attributes).toMatchObject({
      "http.request.method": "GET",
      "url.full": `${server.base}/ok?x=1`,
      "server.address": "127.0.0.1",
      "server.port": server.port,
      "http.response.status_code": 200,
      "http.response.header.content-type": ["text/plain"],
    });
    expect(
      span?.attributes["http.response.header.x-not-listed"],
    ).toBeUndefined();
    expect(span?.attributes["nestrix.http.body"]).toBeUndefined();
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    const sent = server.received[0]?.traceparent ?? [];
    expect(sent).toHaveLength(1);
    const m = tp.exec(sent[0] ?? "");
    expect(m?.[1]).toBe(span?.spanContext().traceId);
    expect(m?.[2]).toBe(span?.spanContext().spanId);
    expect(diagnostics.failures).toEqual([]);
  });

  it("redacts listed query values and drops userinfo and the fragment in url.full", async () => {
    await inParent(() =>
      get(`${server.base}/ok?token=abc&page=2&api%5Fkey=zz`, {
        auth: "user:pass",
      }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const url = clientSpans(exporter)[0]?.attributes["url.full"];
    expect(url).toBe(
      `${server.base}/ok?token=REDACTED&page=2&api%5Fkey=REDACTED`,
    );
    expect(String(url)).not.toContain("pass");
    // The request itself still carries everything the caller set.
    expect(server.received[0]?.url).toBe("/ok?token=abc&page=2&api%5Fkey=zz");
    expect(server.received[0]?.headers.authorization).toMatch(/^Basic /);
  });

  it("lowercases the host, so ignore.outgoing prefixes match whatever case the caller used", async () => {
    install({ ignore: { outgoing: [`http://localhost:${server.port}/404`] } });
    await inParent(async () => {
      await get(`http://LOCALHOST:${server.port}/ok`);
      await get(`http://LocalHost:${server.port}/404`);
    });
    await waitFor(() => clientSpans(exporter).length === 1);
    await sleep(50);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["url.full"]).toBe(
      `http://localhost:${server.port}/ok`,
    );
    expect(span?.attributes["server.address"]).toBe("localhost");
    expect(span?.attributes["server.port"]).toBe(server.port);
  });

  it("a caller-set Host header hides the port: url.full and server.port have none", async () => {
    await inParent(() =>
      get(`${server.base}/ok`, { headers: { host: "collector.test" } }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["url.full"]).toBe("http://127.0.0.1/ok");
    expect(span?.attributes["server.port"]).toBeUndefined();
  });

  it("forward-proxy target that is not a parseable URL: userinfo never recorded", async () => {
    // Port 99999 makes `new URL()` throw; the request still goes out to the proxy.
    const { result } = await inParent(() =>
      get(`${server.base}/ignored`, {
        path: "http://alice:hunter2@api.example.com:99999/v1?token=t",
      }),
    );
    expect(result.status).toBe(200);
    expect(server.received[0]?.url).toBe(
      "http://alice:hunter2@api.example.com:99999/v1?token=t",
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const url = String(clientSpans(exporter)[0]?.attributes["url.full"]);
    expect(url).toBe(`${server.base}/v1?token=REDACTED`);
    expect(url).not.toMatch(/alice|hunter2/);
  });

  it("forward-proxy target with # in the password: neither user nor password recorded", async () => {
    const { result } = await inParent(() =>
      get(`${server.base}/ignored`, {
        path: "http://alice:hun#ter2@api.example.com/v1",
      }),
    );
    // Node's server parser rejects a raw `#` in the target; what matters is what was recorded.
    expect(result.status).toBe(400);
    await waitFor(() => clientSpans(exporter).length === 1);
    const url = String(clientSpans(exporter)[0]?.attributes["url.full"]);
    expect(url).toBe("http://api.example.com/v1");
    expect(url).not.toMatch(/alice|hun/);
  });

  it("records allowlisted request headers, and authorization as REDACTED only when listed", async () => {
    install({ http: { requestHeaders: ["authorization", "x-tenant"] } });
    await inParent(() =>
      get(`${server.base}/ok`, {
        headers: {
          authorization: "Bearer secret",
          "x-tenant": "t1",
          "x-request-id": "r1",
          "x-other": "no",
        },
      }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const a = clientSpans(exporter)[0]?.attributes ?? {};
    expect(a["http.request.header.authorization"]).toEqual(["REDACTED"]);
    expect(a["http.request.header.x-tenant"]).toEqual(["t1"]);
    expect(a["http.request.header.x-request-id"]).toEqual(["r1"]);
    expect(a["http.request.header.x-other"]).toBeUndefined();
  });

  it("keeps a traceparent the caller set and still records a span", async () => {
    const callers = "00-11111111111111111111111111111111-2222222222222222-01";
    await inParent(() =>
      get(`${server.base}/ok`, { headers: { traceparent: callers } }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    expect(server.received[0]?.traceparent).toEqual([callers]);
  });

  it("adds nothing (no tracestate either) when the caller set traceparent and the parent has a tracestate", async () => {
    const callers = "00-11111111111111111111111111111111-2222222222222222-01";
    const remote = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
      traceState: createTraceState("vendor=abc"),
    });
    await context.with(remote, async () => {
      // Control: without a caller header both fields go out.
      await get(`${server.base}/ok`);
      await get(`${server.base}/ok`, { headers: { traceparent: callers } });
    });
    expect(server.received[0]?.headers.tracestate).toBe("vendor=abc");
    expect(server.received[1]?.traceparent).toEqual([callers]);
    expect(server.received[1]?.headers.tracestate).toBeUndefined();
  });

  it("with headers given as an array:the request goes out unchanged, a span is recorded, nothing is counted", async () => {
    const result = await inParent(
      () =>
        new Promise<Outcome>((resolve) => {
          const req = http.request(
            `${server.base}/ok`,
            {
              headers: [
                "host",
                `127.0.0.1:${server.port}`,
                "x-array",
                "1",
              ] as unknown as http.OutgoingHttpHeaders,
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve({ status: res.statusCode }));
            },
          );
          req.on("error", (e) => resolve({ error: e.message }));
          req.end();
        }),
    );
    expect(result.result).toEqual({ status: 200 });
    await waitFor(() => clientSpans(exporter).length === 1);
    expect(server.received[0]?.traceparent).toEqual([]);
    expect(server.received[0]?.headers["x-array"]).toBe("1");
    expect(diagnostics.failures).toEqual([]);
  });

  it("creates no span and sends no header outside a request (no active span)", async () => {
    const result = await get(`${server.base}/ok`);
    expect(result.status).toBe(200);
    await sleep(50);
    expect(clientSpans(exporter)).toEqual([]);
    expect(server.received[0]?.traceparent).toEqual([]);
  });

  it("creates no span and sends no header in a suppressed context, even with an active span", async () => {
    await inParent(() =>
      context.with(suppressed(context.active()), () =>
        get(`${server.base}/ok`),
      ),
    );
    await sleep(50);
    expect(clientSpans(exporter)).toEqual([]);
    expect(server.received[0]?.traceparent).toEqual([]);
  });

  it("under an unsampled parent: no recorded span, and the traceparent carries the decision", async () => {
    await context.with(unsampledParent(), () => get(`${server.base}/ok`));
    await sleep(50);
    expect(clientSpans(exporter)).toEqual([]);
    const sent = server.received[0]?.traceparent ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(
      /^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-00$/,
    );
  });

  it("honours ignore.outgoing: string prefix, RegExp and function", async () => {
    install({
      ignore: {
        outgoing: [
          `${server.base}/ok?a`,
          /\/404$/,
          (url) => url.endsWith("/500"),
        ],
      },
    });
    await inParent(async () => {
      await get(`${server.base}/ok?a=1`);
      await get(`${server.base}/404`);
      await get(`${server.base}/500`);
      await get(`${server.base}/ok?b=1`);
    });
    await waitFor(() => clientSpans(exporter).length === 1);
    await sleep(50);
    expect(clientSpans(exporter).map((s) => s.attributes["url.full"])).toEqual([
      `${server.base}/ok?b=1`,
    ]);
    expect(server.received.map((r) => r.traceparent.length)).toEqual([
      0, 0, 0, 1,
    ]);
  });

  it("a throwing ignore matcher skips tracing for that request, counts once per call, and the request succeeds", async () => {
    install({
      ignore: {
        outgoing: [
          () => {
            throw new Error("matcher bug");
          },
        ],
      },
    });
    const { result } = await inParent(() => get(`${server.base}/ok`));
    expect(result).toEqual({ status: 200, body: "ok" });
    await sleep(50);
    expect(clientSpans(exporter)).toEqual([]);
    expect(server.received[0]?.traceparent).toEqual([]);
    expect(diagnostics.failures.map((f) => f.where)).toEqual([
      "outbound.ignore-matcher",
    ]);
  });

  it("names an unknown method HTTP and records it as _OTHER", async () => {
    await inParent(
      () =>
        new Promise<void>((resolve) => {
          const req = http.request(
            `${server.base}/ok`,
            { method: "PURGE" },
            (res) => {
              res.resume();
              res.on("end", resolve);
            },
          );
          req.end();
        }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.name).toBe("HTTP");
    expect(span?.attributes["http.request.method"]).toBe("_OTHER");
    expect(span?.attributes["http.request.method_original"]).toBe("PURGE");
  });
});

describe("node:http client span ending", () => {
  it("body read: ends after the body, not at the head", async () => {
    const started = Date.now();
    const { result } = await inParent(() => get(`${server.base}/slow-body`));
    expect(result.status).toBe(200);
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    const ms = span ? span.duration[0] * 1000 + span.duration[1] / 1e6 : 0;
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes["nestrix.http.body"]).toBeUndefined();
  });

  it("body never read: ends at the head, marked not consumed", async () => {
    const agent = new http.Agent({ keepAlive: false });
    const { result } = await inParent(
      () =>
        new Promise<number | undefined>((resolve) => {
          http.get(`${server.base}/big`, { agent }, (res) =>
            resolve(res.statusCode),
          );
        }),
    );
    expect(result).toBe(200);
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["nestrix.http.body"]).toBe("not consumed");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    agent.destroy();
  });

  it("no 'response' listener at all: Node dumps the body and the span ends on close", async () => {
    await inParent(
      () =>
        new Promise<void>((resolve) => {
          const req = http.get(`${server.base}/big`);
          req.on("close", () => resolve());
        }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    expect(
      clientSpans(exporter)[0]?.attributes["nestrix.http.body"],
    ).toBeUndefined();
  });

  it.each([
    ["req.destroy()", (req: http.ClientRequest) => req.destroy()],
    [
      "res.destroy()",
      (_req: http.ClientRequest, res: http.IncomingMessage) => res.destroy(),
    ],
  ])(
    "caller cancels mid-body with %s: not an error, marked cancelled, status kept",
    async (_name, cancel) => {
      await inParent(
        () =>
          new Promise<void>((resolve) => {
            const req = http.get(`${server.base}/slow-body`, (res) => {
              res.on("error", () => undefined);
              res.once("data", () => {
                cancel(req, res);
                resolve();
              });
            });
            req.on("error", () => resolve());
          }),
      );
      await waitFor(() => clientSpans(exporter).length === 1);
      const span = clientSpans(exporter)[0];
      expect(span?.status.code).toBe(SpanStatusCode.UNSET);
      expect(span?.attributes["nestrix.http.body"]).toBe("cancelled");
      expect(span?.attributes["http.response.status_code"]).toBe(200);
      expect(span?.attributes["error.type"]).toBeUndefined();
      expect(span?.events).toEqual([]);
    },
  );

  it("caller destroys mid-body with an error of its own: an error", async () => {
    await inParent(
      () =>
        new Promise<void>((resolve) => {
          const req = http.get(`${server.base}/slow-body`, (res) => {
            res.on("error", () => undefined);
            res.once("data", () => {
              req.destroy(new Error("caller gave up"));
              resolve();
            });
          });
          req.on("error", () => resolve());
        }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    expect(clientSpans(exporter)[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("server cuts the connection mid-body: an error, not cancelled", async () => {
    await inParent(() => get(`${server.base}/cut-mid`));
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.attributes["error.type"]).toBe("ECONNRESET");
    expect(span?.attributes["nestrix.http.body"]).toBeUndefined();
  });

  it("server error status: error status with error.type = status code", async () => {
    await inParent(() => get(`${server.base}/500`));
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("500");
  });

  it("connection refused: error with error.type ECONNREFUSED", async () => {
    const port = await closedPort();
    const { result } = await inParent(() => get(`http://127.0.0.1:${port}/x`));
    expect(result.error).toBe("ECONNREFUSED");
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("ECONNREFUSED");
    expect(span?.events.map((e) => e.name)).toEqual(["exception"]);
  });

  it("server destroys the socket, abort before response, destroy before connect: each ends with an error", async () => {
    await inParent(async () => {
      await get(`${server.base}/destroy`);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      await get(`${server.base}/hang`, { signal: ac.signal });
      await new Promise<void>((resolve) => {
        const req = http.get(`${server.base}/never`);
        req.on("error", () => undefined);
        req.on("close", () => resolve());
        req.destroy();
      });
    });
    await waitFor(() => clientSpans(exporter).length === 3);
    expect(clientSpans(exporter).map((s) => s.status.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
  });

  it("an upgrade response (no response.finish) ends when the request closes", async () => {
    await inParent(
      () =>
        new Promise<void>((resolve) => {
          const req = http.request(`${server.base}/up`, {
            headers: { connection: "Upgrade", upgrade: "test" },
          });
          req.on("upgrade", (_res, socket) => {
            socket.destroy();
            resolve();
          });
          req.end();
        }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    expect(clientSpans(exporter)[0]?.attributes["url.full"]).toBe(
      `${server.base}/up`,
    );
  });

  it("every case ends its span exactly once (one finished span each, no second end())", async () => {
    const port = await closedPort();
    const agent = new http.Agent({ keepAlive: false });
    await inParent(async () => {
      await get(`${server.base}/ok`);
      await get(`${server.base}/500`);
      await get(`${server.base}/slow-body`);
      await get(`http://127.0.0.1:${port}/x`);
      await get(`${server.base}/destroy`);
      await get(`${server.base}/cut-mid`);
      await new Promise<void>((r) => {
        http.get(`${server.base}/big`, { agent }, () => r());
      });
      await new Promise<void>((r) => {
        const req = http.get(`${server.base}/slow-body`, (res) => {
          res.once("data", () => {
            req.destroy();
            r();
          });
        });
        req.on("error", () => undefined);
      });
    });
    await waitFor(() => clientSpans(exporter).length >= 8);
    await sleep(400);
    expect(clientSpans(exporter)).toHaveLength(8);
    expect(doubleEnds).toEqual([]);
    agent.destroy();
  });

  it("the double-end check works: a span ended twice is recorded", () => {
    const span = trace.getTracer("test").startSpan("twice");
    span.end();
    span.end();
    expect(doubleEnds).toHaveLength(1);
    doubleEnds.length = 0;
  });
});

describe("node:http subscriber faults (rule 1)", () => {
  const sites = [
    "node-http.created",
    "node-http.response",
    "node-http.close",
    "node-http.unconsumed",
    "node-http.request-close",
    "node-http.error",
  ];

  it.each(sites)(
    "a throw in %s: the request behaves the same, no uncaughtException, the failure is counted",
    async (site) => {
      const uncaught = trackUncaught();
      setOutboundFaultForTests((s) => {
        if (s === site) throw new Error(`injected ${s}`);
      });
      const port = await closedPort();
      const agent = new http.Agent({ keepAlive: false });
      const outcomes = await inParent(async () => [
        await get(`${server.base}/ok`),
        await get(`${server.base}/500`),
        await get(`http://127.0.0.1:${port}/x`),
        await new Promise<number | undefined>((r) => {
          http.get(`${server.base}/big`, { agent }, (res) => r(res.statusCode));
        }),
      ]);
      await sleep(100);
      uncaught.stop();
      agent.destroy();
      expect(outcomes.result).toEqual([
        { status: 200, body: "ok" },
        { status: 500, body: "no" },
        { error: "ECONNREFUSED" },
        200,
      ]);
      expect(uncaught.errors).toEqual([]);
      expect(diagnostics.failures.length).toBeGreaterThan(0);
      expect(
        diagnostics.failures.every((f) => f.where === `outbound.${site}`),
      ).toBe(true);
    },
  );
});

describe("installation", () => {
  const traceOne = async (): Promise<number> => {
    exporter.reset();
    await inParent(() => get(`${server.base}/ok`));
    await sleep(50);
    return clientSpans(exporter).length;
  };

  it("two apps: closing the first keeps tracing for the second; the last close unsubscribes", async () => {
    // `uninstall` is app A's (installed in beforeEach); B installs second.
    const b = installOutbound(resolved(), diagnostics);
    expect(diagnostics.logs.has("outbound.second-instance")).toBe(true);
    expect(await traceOne()).toBe(1); // one subscription, not two

    uninstall(); // A closes
    uninstall(); // idempotent: does not release B's reference
    expect(await traceOne()).toBe(1);

    b(); // B closes: nothing left
    expect(await traceOne()).toBe(0);
    expect(server.received.at(-1)?.traceparent).toEqual([]);
    b();

    install(); // a later app subscribes again
    expect(await traceOne()).toBe(1);
  });

  it("B closing first, then A: same outcome", async () => {
    const b = installOutbound(resolved(), diagnostics);
    b();
    expect(await traceOne()).toBe(1);
    uninstall();
    expect(await traceOne()).toBe(0);
    install();
  });
});
