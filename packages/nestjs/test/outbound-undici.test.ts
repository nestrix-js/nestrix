// fetch/undici client spans (P1-09). Global state: a host-style provider with an in-memory exporter.
// Covers the global `fetch` (the undici bundled in Node) and the `undici` npm package (a separate
// copy; devDependency for these tests only), which publish on the same named channels.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  context,
  createTraceState,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import * as undici from "undici";
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
// Longer than the slow-body route's 300 ms gap, or that body would be cut at the head (the
// documented limitation of the grace timer).
const GRACE = 600;

function install(options: Parameters<typeof resolved>[0] = {}): void {
  uninstall();
  diagnostics = recordingDiagnostics();
  uninstall = installOutbound(resolved(options), diagnostics, {
    unreadGraceMillis: GRACE,
  });
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

type Init = { headers?: Record<string, string>; signal?: AbortSignal };
interface Client {
  /** Sends the request and reads the whole body. */
  read(url: string, init?: Init): Promise<{ status: number; body: string }>;
  /** Sends the request and never touches the body; keeps the response reachable. */
  unread(url: string, init?: Init): Promise<number>;
  /** Sends the request and cancels the body once the head arrived. */
  cancel(url: string): Promise<void>;
}

const kept: unknown[] = [];
const clients: Record<string, Client> = {
  "global fetch": {
    async read(url, init) {
      const r = await fetch(url, init);
      return { status: r.status, body: await r.text() };
    },
    async unread(url, init) {
      const r = await fetch(url, init);
      kept.push(r);
      return r.status;
    },
    async cancel(url) {
      const r = await fetch(url);
      await r.body?.cancel();
    },
  },
  "undici.request": {
    async read(url, init) {
      const r = await undici.request(url, init);
      return { status: r.statusCode, body: await r.body.text() };
    },
    async unread(url, init) {
      const r = await undici.request(url, init);
      kept.push(r);
      return r.statusCode;
    },
    async cancel(url) {
      const r = await undici.request(url);
      r.body.on("error", () => undefined);
      r.body.destroy();
    },
  },
  "undici.fetch": {
    async read(url, init) {
      const r = await undici.fetch(url, init);
      return { status: r.status, body: await r.text() };
    },
    async unread(url, init) {
      const r = await undici.fetch(url, init);
      kept.push(r);
      return r.status;
    },
    async cancel(url) {
      const r = await undici.fetch(url);
      await r.body?.cancel();
    },
  },
};

const tp = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;
const durationMs = (s: { duration: [number, number] } | undefined) =>
  s ? s.duration[0] * 1000 + s.duration[1] / 1e6 : -1;

describe.each(Object.entries(clients))("%s", (_name, client) => {
  it("is a child of the active span and sends its traceparent", async () => {
    const { parent, result } = await inParent(() =>
      client.read(`${server.base}/ok?token=t&x=1`),
    );
    expect(result).toEqual({ status: 200, body: "ok" });
    await waitFor(() => clientSpans(exporter).length === 1);
    const [span] = clientSpans(exporter);
    expect(span?.name).toBe("GET");
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span?.attributes).toMatchObject({
      "http.request.method": "GET",
      "url.full": `${server.base}/ok?token=REDACTED&x=1`,
      "server.address": "127.0.0.1",
      "server.port": server.port,
      "http.response.status_code": 200,
      "http.response.header.content-type": ["text/plain"],
    });
    expect(
      span?.attributes["http.response.header.x-not-listed"],
    ).toBeUndefined();
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    const sent = server.received[0]?.traceparent ?? [];
    expect(sent).toHaveLength(1);
    const m = tp.exec(sent[0] ?? "");
    expect(m?.[1]).toBe(span?.spanContext().traceId);
    expect(m?.[2]).toBe(span?.spanContext().spanId);
    expect(server.received[0]?.url).toBe("/ok?token=t&x=1");
    expect(diagnostics.failures).toEqual([]);
  });

  it("keeps a traceparent the caller set: exactly one, the caller's, and no tracestate added", async () => {
    const callers = "00-11111111111111111111111111111111-2222222222222222-01";
    const remote = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
      traceState: createTraceState("vendor=abc"),
    });
    await context.with(remote, async () => {
      await client.read(`${server.base}/ok`);
      await client.read(`${server.base}/ok`, {
        headers: { TraceParent: callers },
      });
    });
    expect(server.received[0]?.headers.tracestate).toBe("vendor=abc");
    expect(server.received[1]?.traceparent).toEqual([callers]);
    expect(server.received[1]?.headers.tracestate).toBeUndefined();
    await waitFor(() => clientSpans(exporter).length === 2);
  });

  it("records allowlisted request headers", async () => {
    install({ http: { requestHeaders: ["x-tenant", "authorization"] } });
    await inParent(() =>
      client.read(`${server.base}/ok`, {
        headers: {
          "x-tenant": "t1",
          authorization: "Bearer s",
          "content-type": "text/plain",
          "x-other": "no",
        },
      }),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const a = clientSpans(exporter)[0]?.attributes ?? {};
    expect(a["http.request.header.x-tenant"]).toEqual(["t1"]);
    expect(a["http.request.header.authorization"]).toEqual(["REDACTED"]);
    expect(a["http.request.header.content-type"]).toEqual(["text/plain"]);
    expect(a["http.request.header.x-other"]).toBeUndefined();
  });

  it("creates no span and sends no header outside a request", async () => {
    await client.read(`${server.base}/ok`);
    await sleep(50);
    expect(clientSpans(exporter)).toEqual([]);
    expect(server.received[0]?.traceparent).toEqual([]);
  });

  it("creates no span and sends no header in a suppressed context, even with an active span", async () => {
    await inParent(() =>
      context.with(suppressed(context.active()), () =>
        client.read(`${server.base}/ok`),
      ),
    );
    await sleep(50);
    expect(clientSpans(exporter)).toEqual([]);
    expect(server.received[0]?.traceparent).toEqual([]);
  });

  it("under an unsampled parent: no recorded span, traceparent with flags 00", async () => {
    await context.with(unsampledParent(), () =>
      client.read(`${server.base}/ok`),
    );
    await sleep(50);
    expect(clientSpans(exporter)).toEqual([]);
    expect(server.received[0]?.traceparent[0]).toMatch(
      /^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-00$/,
    );
  });

  it("honours ignore.outgoing", async () => {
    install({
      ignore: {
        outgoing: [`${server.base}/404`, /\/500$/, (u) => u.includes("skip")],
      },
    });
    await inParent(async () => {
      await client.read(`${server.base}/404`);
      await client.read(`${server.base}/500`);
      await client.read(`${server.base}/ok?skip=1`);
      await client.read(`${server.base}/ok`);
    });
    await waitFor(() => clientSpans(exporter).length === 1);
    await sleep(50);
    expect(clientSpans(exporter).map((s) => s.attributes["url.full"])).toEqual([
      `${server.base}/ok`,
    ]);
    expect(server.received.map((r) => r.traceparent.length)).toEqual([
      0, 0, 0, 1,
    ]);
  });

  it("body read slowly: ends after the body", async () => {
    await inParent(() => client.read(`${server.base}/slow-body`));
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(durationMs(span)).toBeGreaterThanOrEqual(250);
    expect(span?.attributes["nestrix.http.body"]).toBeUndefined();
  });

  it("small body never read: undici buffers it and the span ends normally", async () => {
    await inParent(() => client.unread(`${server.base}/ok`));
    await waitFor(() => clientSpans(exporter).length === 1);
    expect(
      clientSpans(exporter)[0]?.attributes["nestrix.http.body"],
    ).toBeUndefined();
  });

  it("large body never read: after the grace period the span ends at the head, marked not consumed", async () => {
    const { result } = await inParent(() =>
      client.unread(`${server.base}/big`),
    );
    expect(result).toBe(200);
    await sleep(GRACE / 2);
    expect(clientSpans(exporter)).toEqual([]);
    await waitFor(() => clientSpans(exporter).length === 1, GRACE * 10);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["nestrix.http.body"]).toBe("not consumed");
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    // Ended at the head, not when the timer fired.
    expect(durationMs(span)).toBeLessThan(GRACE);
    kept.length = 0;
  });

  it("server error status: error status with error.type = status code", async () => {
    await inParent(() => client.read(`${server.base}/500`));
    await waitFor(() => clientSpans(exporter).length === 1);
    expect(clientSpans(exporter)[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(clientSpans(exporter)[0]?.attributes["error.type"]).toBe("500");
  });

  it("connection refused: error with error.type ECONNREFUSED, no header (never connected)", async () => {
    const port = await closedPort();
    await inParent(() =>
      client.read(`http://127.0.0.1:${port}/x`).catch(() => undefined),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("ECONNREFUSED");
    expect(span?.attributes["server.port"]).toBe(port);
  });

  it("aborted before the response: error", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await inParent(() =>
      client.read(`${server.base}/hang`, { signal: ac.signal }).catch((e) => e),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["http.response.status_code"]).toBeUndefined();
    expect(span?.attributes["error.type"]).toBe("AbortError");
  });

  it("caller aborts after the head (mid-body): not an error, marked cancelled, status kept", async () => {
    const ac = new AbortController();
    await inParent(async () => {
      const p = client.read(`${server.base}/slow-body`, { signal: ac.signal });
      setTimeout(() => ac.abort(), 100);
      await p.catch(() => undefined);
    });
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes["nestrix.http.body"]).toBe("cancelled");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.attributes["error.type"]).toBeUndefined();
    expect(span?.events).toEqual([]);
  });

  it("caller cancels the body: marked cancelled, not an error", async () => {
    await inParent(() => client.cancel(`${server.base}/slow-body`));
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes["nestrix.http.body"]).toBe("cancelled");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
  });

  it("caller cancels the body of a 500: cancelled, and the status code's error stands", async () => {
    await inParent(() => client.cancel(`${server.base}/500`));
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["http.response.status_code"]).toBe(500);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("500");
  });

  it("server cuts the connection mid-body: an error, not cancelled", async () => {
    await inParent(() =>
      client.read(`${server.base}/cut-mid`).catch(() => undefined),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.attributes["error.type"]).toBe("UND_ERR_SOCKET");
    expect(span?.attributes["nestrix.http.body"]).toBeUndefined();
  });

  it("server destroys the socket: error", async () => {
    await inParent(() =>
      client.read(`${server.base}/destroy`).catch(() => undefined),
    );
    await waitFor(() => clientSpans(exporter).length === 1);
    expect(clientSpans(exporter)[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// The bundled copy alone (Node 22.15's undici 6 publishes only `create` for an upgrade) is
// tested in outbound-websocket.test.ts: this file loads npm undici 7, whose Agent becomes the
// process-wide global dispatcher that Node's own WebSocket and fetch then use.
describe("undici.WebSocket (npm copy, an upgrade request)", () => {
  it("its span ends at the 101 head", async () => {
    const { result } = await inParent(
      () =>
        new Promise<string>((resolve) => {
          const ws = new undici.WebSocket(`ws://127.0.0.1:${server.port}/ws`);
          let opened = false;
          ws.onopen = () => {
            opened = true;
          };
          ws.onerror = () => undefined;
          ws.onclose = () => resolve(opened ? "opened" : "failed");
        }),
    );
    expect(result).toBe("opened");
    await waitFor(() => clientSpans(exporter).length === 1, GRACE * 5);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["url.full"]).toBe(`${server.base}/ws`);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes["http.response.status_code"]).toBe(101);
  });
});

describe("cancel with a non-Error reason", () => {
  it("fetch body.cancel('reason') after the head is cancelled, not an error", async () => {
    await inParent(async () => {
      const r = await fetch(`${server.base}/slow-body`);
      await r.body?.cancel("not needed");
    });
    await waitFor(() => clientSpans(exporter).length === 1);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["nestrix.http.body"]).toBe("cancelled");
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe("fetch following a redirect", () => {
  it("gives each hop its own span and exactly one traceparent, its own", async () => {
    const { result } = await inParent(async () => {
      const r = await fetch(`${server.base}/redirect`);
      return { status: r.status, body: await r.text() };
    });
    expect(result).toEqual({ status: 200, body: "ok" });
    await waitFor(() => clientSpans(exporter).length === 2);
    const spans = clientSpans(exporter);
    expect(spans.map((s) => s.attributes["http.response.status_code"])).toEqual(
      [302, 200],
    );
    expect(server.received.map((r) => r.url)).toEqual(["/redirect", "/ok"]);
    for (const [i, hop] of server.received.entries()) {
      expect(hop.traceparent).toHaveLength(1);
      expect(hop.traceparent[0]?.split("-")[2]).toBe(
        spans[i]?.spanContext().spanId,
      );
    }
  });
});

describe("global fetch: a Response collected unread", () => {
  it("fetch's garbage-collection cancel ends the span at the head as not consumed, not as an error", async () => {
    // A long grace, so only the collection can end the span within the test.
    uninstall();
    uninstall = installOutbound(resolved(), diagnostics, {
      unreadGraceMillis: 60_000,
    });
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    await inParent(async () => {
      const r = await fetch(`${server.base}/big`);
      expect(r.status).toBe(200);
    });
    for (let i = 0; i < 50 && clientSpans(exporter).length === 0; i++) {
      gc();
      await sleep(20);
    }
    expect(clientSpans(exporter)).toHaveLength(1);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["nestrix.http.body"]).toBe("not consumed");
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.events).toEqual([]);
  });
});

describe("undici subscriber faults (rule 1)", () => {
  const sites = [
    "undici.create",
    "undici.headers",
    "undici.trailers",
    "undici.error",
    "undici.unconsumed",
  ];
  it.each(sites)(
    "a throw in %s: requests behave the same, no uncaughtException, the failure is counted",
    async (site) => {
      const uncaught = trackUncaught();
      setOutboundFaultForTests((s) => {
        if (s === site) throw new Error(`injected ${s}`);
      });
      const port = await closedPort();
      const { result } = await inParent(async () => [
        await clients["global fetch"]?.read(`${server.base}/ok`),
        await clients["undici.request"]?.read(`${server.base}/500`),
        await fetch(`http://127.0.0.1:${port}/x`).then(
          () => "resolved",
          (e: Error) => e.name,
        ),
        await clients["undici.request"]?.unread(`${server.base}/big`),
      ]);
      await sleep(GRACE * 2);
      uncaught.stop();
      kept.length = 0;
      expect(result).toEqual([
        { status: 200, body: "ok" },
        { status: 500, body: "no" },
        "TypeError",
        200,
      ]);
      expect(uncaught.errors).toEqual([]);
      expect(diagnostics.failures.length).toBeGreaterThan(0);
      expect(
        diagnostics.failures.every((f) => f.where === `outbound.${site}`),
      ).toBe(true);
    },
  );

  it("a throw in undici.chunk (Node 24+ publishes bodyChunkReceived): the body still arrives", async () => {
    const uncaught = trackUncaught();
    setOutboundFaultForTests((s) => {
      if (s === "undici.chunk") throw new Error("injected chunk");
    });
    const { result } = await inParent(() =>
      clients["global fetch"]?.read(`${server.base}/slow-body`),
    );
    uncaught.stop();
    expect(result?.body).toHaveLength(2000);
    expect(uncaught.errors).toEqual([]);
    await waitFor(() => clientSpans(exporter).length === 1);
  });
});
