import { beforeAll, describe, expect, it } from "vitest";
import {
  childrenOf,
  type FixtureResult,
  nodeBinaries,
  requireBuilt,
  runFixture,
  SPAN_KIND_CLIENT,
  type SpanRecord,
  STATUS_ERROR,
} from "./helpers.js";

// Q1 (fetch via @opentelemetry/instrumentation-undici) and Q2 (node:http client via
// Node's http.client.* channels). The fixture apps are run with plain `node`.

requireBuilt();

interface Tagged {
  spanId: string;
  traceId?: string;
  result: unknown;
}

function handler(r: FixtureResult, scenario: string): Tagged {
  const res = r.responses[scenario];
  expect(res?.status, JSON.stringify(res)).toBe(200);
  return res?.body as Tagged;
}

function traceparentFor(span: SpanRecord): string {
  return `00-${span.traceId}-${span.spanId}-01`;
}

function assertOut(r: FixtureResult) {
  expect(r.execArgv).toEqual([]);
  expect(r.nodeOptions).toBe("");
  const h = handler(r, "out");
  expect(h.result).toEqual({ fetch: 200, http: 200 });
  const kids = childrenOf(r.spans, h.spanId);
  const fetchSpan = kids.find((s) =>
    s.attributes["url.full"]?.toString().endsWith("/fetch"),
  );
  const httpSpan = kids.find((s) =>
    s.attributes["url.full"]?.toString().endsWith("/http"),
  );
  // Q1: a client span from instrumentation-undici, child of the active span...
  expect(fetchSpan?.kind).toBe(SPAN_KIND_CLIENT);
  // ...and the traceparent the server received names that span.
  expect(r.received.find((x) => x.path === "/fetch")?.traceparent).toBe(
    traceparentFor(fetchSpan as SpanRecord),
  );
  // Q2: a node:http client span from the channel subscriber, header set in `created`.
  expect(httpSpan?.kind).toBe(SPAN_KIND_CLIENT);
  expect(httpSpan?.attributes["nestrix.http.injected"]).toBe(true);
  expect(r.received.find((x) => x.path === "/http")?.traceparent).toBe(
    traceparentFor(httpSpan as SpanRecord),
  );
  // fetch does not also publish http.client.* (no duplicate span for /fetch).
  const fetchSpans = r.spans.filter((s) =>
    s.attributes["url.full"]?.toString().endsWith("/fetch"),
  );
  expect(fetchSpans).toHaveLength(1);
  return { fetchSpan, httpSpan };
}

describe.each(nodeBinaries())("Q1/Q2 on Node $label", ({ bin }) => {
  let esm: FixtureResult;
  let cjs: FixtureResult;
  let stderr: string[] = [];
  beforeAll(async () => {
    const [e, c] = await Promise.all([
      runFixture("esm", ["out", "http-cases", "fetch-error"], { node: bin }),
      runFixture("cjs", ["out"], { node: bin }),
    ]);
    expect(e.result, e.stderr).toBeDefined();
    expect(c.result, c.stderr).toBeDefined();
    esm = e.result as FixtureResult;
    cjs = c.result as FixtureResult;
    stderr = [e.stderr, c.stderr];
  });

  it("no warning of any kind on stderr (require(esm), deprecations, experimental features)", () => {
    expect(stderr).toEqual(["", ""]);
  });

  it("ESM app: fetch and node:http spans are children of the active span and traceparent is sent", () => {
    assertOut(esm);
    expect(esm.failures).toEqual({ "http.inject": 1 }); // the array-headers case below
  });

  it("CJS app (stand-in loaded with require(esm)): same", () => {
    assertOut(cjs);
    expect(cjs.failures).toEqual({});
  });

  it("instrumentation was enabled from module initialisation, with no preload flag", () => {
    for (const r of [esm, cjs]) {
      expect(r.enable.tracing).toEqual({
        contextManager: true,
        provider: true,
        propagator: true,
      });
      expect(r.enable.undici.enabled).toBe(true);
    }
  });

  it("finding: constructing UndiciInstrumentation installs a global require hook", () => {
    // InstrumentationBase creates the require-in-the-middle singleton in its constructor,
    // even though instrumentation-undici patches no module.
    expect(esm.enable.undici.requireHookInstalled).toBe(true);
    expect(cjs.enable.undici.requireHookInstalled).toBe(true);
  });

  it("fetch to an unreachable host: span ends with error status", () => {
    const h = handler(esm, "fetch-error");
    expect(h.result).toBe("fetch failed");
    const [span] = childrenOf(esm.spans, h.spanId);
    expect(span?.status.code).toBe(STATUS_ERROR);
  });

  it("Q2: Node publishes the http.client.* channels used", () => {
    for (const ch of [
      "http.client.request.created",
      "http.client.request.start",
      "http.client.response.finish",
      "http.client.request.error",
    ]) {
      expect(esm.httpChannelsSeen[ch], ch).toBeGreaterThan(0);
    }
  });

  describe("Q2: node:http lifecycle cases", () => {
    const span = (name: string) => {
      const h = handler(esm, "http-cases");
      const cases = h.result as Array<{ name: string }>;
      const index = cases.findIndex((c) => c.name === name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      // One span per case, in order, all children of the handler span.
      const kids = childrenOf(esm.spans, h.spanId).sort(
        (a, b) => a.startMs - b.startMs,
      );
      expect(kids).toHaveLength(cases.length);
      return {
        span: kids[index] as SpanRecord,
        result: cases[index] as Record<string, unknown>,
      };
    };

    it("every case ends its span exactly once (no leaked span, no duplicate)", () => {
      const h = handler(esm, "http-cases");
      const cases = h.result as Array<{ name: string }>;
      expect(cases).toHaveLength(17);
      const kids = childrenOf(esm.spans, h.spanId);
      // One finished span per case: none missing (a leak never exports), none twice.
      expect(kids).toHaveLength(cases.length);
      expect(new Set(kids.map((k) => k.spanId)).size).toBe(cases.length);
      for (const k of kids)
        expect(k.attributes["nestrix.http.ended_by"]).toBeDefined();
      // The SDK exports a span once even if end() is called twice, so also check that
      // each case recorded exactly one ending event.
      for (const k of kids) {
        const events = String(k.attributes["nestrix.http.events"]).split(",");
        const enders = events.filter((e) =>
          [
            "request.error",
            "response.close",
            "response.close(incomplete)",
            "response.unconsumed",
          ].includes(e),
        );
        expect(enders.length, String(k.attributes["url.full"])).toBe(1);
      }
    });

    it("F2: a caller that never reads the body: the span ends at the head, marked 'not consumed'", () => {
      const { span: s, result } = span("unreadBody");
      expect(result.status).toBe(200);
      expect(s.attributes["nestrix.http.ended_by"]).toBe("response.unconsumed");
      expect(s.attributes["nestrix.http.body"]).toBe("not consumed");
      expect(s.status.code).not.toBe(STATUS_ERROR);
    });

    it("F2: no 'response' listener at all: Node dumps the body, the span ends on 'close'", () => {
      const { span: s } = span("noResponseListener");
      expect(s.attributes["nestrix.http.ended_by"]).toBe("response.close");
    });

    it("F2 limitation: a caller that starts reading on a later tick gets a span that ended at the head", () => {
      const { span: s, result } = span("lateConsumer");
      expect(s.attributes["nestrix.http.ended_by"]).toBe("response.unconsumed");
      expect(s.endMs).toBeLessThan(result.bodyEndMs as number);
    });

    it("200 and 500: ended from the response; 500 has error status", () => {
      expect(span("ok").span.attributes["http.response.status_code"]).toBe(200);
      expect(span("status500").span.status.code).toBe(STATUS_ERROR);
    });

    it("response.finish fires at the response head; the span waits for the body via 'close'", () => {
      const { span: s, result } = span("slowBody");
      expect(s.attributes["nestrix.http.events"]).toBe(
        "created,start,response.finish,response.close",
      );
      expect(s.endMs - s.startMs).toBeGreaterThanOrEqual(250);
      expect(Math.abs(s.endMs - (result.bodyEndMs as number))).toBeLessThan(50);
    });

    it("errors before a response end the span from http.client.request.error", () => {
      for (const name of [
        "refused",
        "serverDestroys",
        "abortBeforeResponse",
        "timeoutDestroy",
        "destroyWithoutError",
        "destroyImmediately",
      ]) {
        const { span: s } = span(name);
        expect(s.attributes["nestrix.http.ended_by"], name).toBe(
          "request.error",
        );
        expect(s.status.code, name).toBe(STATUS_ERROR);
      }
    });

    it("a client abort after the head is visible only through response 'close' (incomplete)", () => {
      const { span: s } = span("abortMidBody");
      expect(s.attributes["nestrix.http.events"]).toContain(
        "response.close(incomplete)",
      );
      expect(s.status.code).toBe(STATUS_ERROR);
    });

    it("headers given as an array: setHeader throws in `created`, the error is caught, the request still succeeds untouched", () => {
      const { span: s, result } = span("arrayHeaders");
      expect(result.status).toBe(200);
      expect(s.attributes["nestrix.http.injected"]).toBe(false);
      expect(s.attributes["nestrix.http.inject_error"]).toMatch(
        /Cannot set headers/,
      );
      expect(
        esm.received.find((x) => x.path === "/array-headers")?.traceparent,
      ).toBeUndefined();
    });

    it("a traceparent the caller set is left alone", () => {
      const { span: s } = span("userTraceparent");
      expect(s.attributes["nestrix.http.inject_skipped"]).toBe(
        "caller set traceparent",
      );
      expect(
        esm.received.find((x) => x.path === "/user-traceparent")?.traceparent,
      ).toBe("00-11111111111111111111111111111111-2222222222222222-01");
    });

    it("keep-alive reuse: each request gets its own span and header", () => {
      const a = span("keepAlive1").span;
      const b = span("keepAlive2").span;
      expect(
        esm.received.find((x) => x.path === "/keepalive-1")?.traceparent,
      ).toBe(traceparentFor(a));
      expect(
        esm.received.find((x) => x.path === "/keepalive-2")?.traceparent,
      ).toBe(traceparentFor(b));
    });
  });
});

describe("Q2 variants (current Node)", () => {
  it("ending on response.finish alone ends at the head and misses a mid-body abort", async () => {
    const r = (
      await runFixture("esm", ["http-cases"], {
        env: { NESTRIX_HTTP_END_ON: "headers" },
      })
    ).result as FixtureResult;
    const h = r.responses["http-cases"]?.body as Tagged;
    const kids = childrenOf(r.spans, h.spanId).sort(
      (a, b) => a.startMs - b.startMs,
    );
    const names = (h.result as Array<{ name: string }>).map((c) => c.name);
    const slow = kids[names.indexOf("slowBody")] as SpanRecord;
    const abort = kids[names.indexOf("abortMidBody")] as SpanRecord;
    expect(slow.endMs - slow.startMs).toBeLessThan(150);
    expect(abort.status.code).not.toBe(STATUS_ERROR);
  });

  it("injecting unconditionally overwrites a traceparent the caller set (why the subscriber checks first)", async () => {
    const r = (
      await runFixture("esm", ["http-cases"], {
        env: { NESTRIX_HTTP_OVERWRITE: "1" },
      })
    ).result as FixtureResult;
    const got = r.received.find(
      (x) => x.path === "/user-traceparent",
    )?.traceparent;
    expect(got).not.toBe(
      "00-11111111111111111111111111111111-2222222222222222-01",
    );
    expect(got).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it.each(["fastify", "node"])(
    "adapter %s: same parentage for GET /out",
    async (adapter) => {
      const r = (
        await runFixture("esm", ["out"], { env: { ADAPTER: adapter } })
      ).result as FixtureResult;
      expect(r.adapter).toBe(adapter);
      assertOut(r);
    },
  );
});
