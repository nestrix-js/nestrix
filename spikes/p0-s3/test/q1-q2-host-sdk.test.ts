import { describe, expect, it } from "vitest";
import { one, type SpanRec, scenario, startScenario } from "./helpers.ts";

const INCOMING_TRACE = "0af7651916cd43dd8448eb211c80319c";
const INCOMING_PARENT = "b7ad6b7169203331";
const TRACEPARENT = `00-${INCOMING_TRACE}-${INCOMING_PARENT}-01`;
const SERVER = 1;
const CLIENT = 2;

const hosts = [
  { format: "esm", file: "host-sdk3-esm.mjs" },
  { format: "cjs", file: "host-sdk3-cjs.cjs" },
] as const;
const adapters = ["express", "fastify", "node"] as const;

/** Asserts the whole chain for one `GET /s3/work` with an incoming traceparent. */
function assertChain(spans: SpanRec[], work: any) {
  const server = one(spans, "GET /s3/work");
  expect(server.kind).toBe(SERVER);
  expect(server.scope).toBe("nestrix-standin");
  expect(server.traceId).toBe(INCOMING_TRACE);
  expect(server.parentSpanId).toBe(INCOMING_PARENT);
  // Host code (host's api copy) saw Nestrix's server span after an await.
  expect(work.seenActiveSpanId).toBe(server.spanId);
  const hostWork = one(spans, "host.work");
  expect(hostWork.scope).toBe("host-app");
  expect(hostWork.parentSpanId).toBe(server.spanId);
  expect(hostWork.traceId).toBe(INCOMING_TRACE);
  // Outbound spans started by Nestrix (ESM api) inside host.work, after a second await.
  const clients = spans.filter((s) => s.kind === CLIENT);
  expect(clients.length).toBe(2); // undici (fetch) + node:http subscriber
  for (const c of clients) {
    expect(c.parentSpanId).toBe(hostWork.spanId);
    expect(c.traceId).toBe(INCOMING_TRACE);
  }
  // The two /hello server spans are children of the two client spans (traceparent went out).
  const hellos = spans.filter((s) => s.name === "GET /hello");
  expect(hellos.length).toBe(2);
  expect(hellos.map((h) => h.parentSpanId).sort()).toEqual(
    clients.map((c) => c.spanId).sort(),
  );
}

describe("Q1: host registers an SDK 3 provider first", () => {
  for (const host of hosts) {
    for (const adapter of adapters) {
      it(`${host.format} host, ${adapter}`, async () => {
        const run = await startScenario(scenario(host.file), {
          S3_ADAPTER: adapter,
        });
        const res = await run.get("/s3/work", { traceparent: TRACEPARENT });
        expect(res.status).toBe(200);
        const { result } = await run.finish();
        console.log(
          `[Q1 ${host.format}/${adapter} node ${result.node}] host registered`,
          result.hostRegistered,
          "nestrix",
          JSON.stringify(result.nestrix),
          "api copies",
          JSON.stringify(result.apiCopies),
          "host spans",
          result.hostSpans
            .map((s: SpanRec) => `${s.name}(${s.scope})`)
            .join(", "),
        );
        expect(result.hostRegistered).toEqual({
          provider: true,
          contextManager: true,
          propagator: true,
        });
        expect(result.nestrix.providerRegistered).toBe(false);
        expect(result.nestrix.contextManagerDetected).toBe(true);
        expect(result.nestrix.contextManagerRegistered).toBeNull();
        expect(result.nestrix.propagatorDetected).toBe(true);
        expect(result.nestrix.propagatorRegistered).toBeNull();
        expect(result.nestrixOwnStore).toEqual([]);
        if (host.format === "cjs") {
          expect(result.apiCopies.hostApiFile).toMatch(/index\.cjs$/);
          expect(result.apiCopies.nestrixApiFile).toMatch(/index\.mjs$/);
          expect(result.apiCopies.sameModuleObject).toBe(false);
        } else {
          expect(result.apiCopies.sameModuleObject).toBe(true);
        }
        assertChain(result.hostSpans, JSON.parse(res.body));
        // The route is kept in Nestrix's own request state, found through its own key.
        expect(result.routeStats).toEqual({
          "GET /s3/work": 1,
          "GET /hello": 2,
        });
        expect(result.faults).toEqual({
          requestHook: 0,
          routeHook: 0,
          closeListener: 0,
          httpSubscriber: 0,
        });
      });
    }
  }

  it("unhappy path: Nestrix sets up before the host (esm, express)", async () => {
    const run = await startScenario(scenario("host-sdk3-esm.mjs"), {
      S3_ORDER: "nestrix-first",
    });
    const res = await run.get("/s3/work", { traceparent: TRACEPARENT });
    expect(res.status).toBe(200);
    const { result } = await run.finish();
    console.log(
      "[Q1 nestrix-first] host registered",
      result.hostRegistered,
      "nestrix",
      JSON.stringify(result.nestrix),
      "host spans",
      result.hostSpans.length,
      "nestrix own store",
      result.nestrixOwnStore.length,
    );
    // Whoever registers first wins every slot; the host's provider is never used.
    expect(result.nestrix.providerRegistered).toBe(true);
    expect(result.hostRegistered).toEqual({
      provider: false,
      contextManager: false,
      propagator: false,
    });
    expect(result.hostSpans).toEqual([]);
    expect(result.nestrixOwnStore.length).toBeGreaterThan(0);
  });
});

describe("Q2: nestrixSpanProcessor() in the host's spanProcessors", () => {
  for (const host of hosts) {
    for (const adapter of adapters) {
      it(`${host.format} host, ${adapter}: store == host exporter`, async () => {
        const run = await startScenario(scenario(host.file), {
          S3_ADAPTER: adapter,
          S3_STORE: "1",
        });
        const res = await run.get("/s3/work", { traceparent: TRACEPARENT });
        expect(res.status).toBe(200);
        expect((await run.get("/nope")).status).toBe(404);
        expect((await run.get("/boom")).status).toBe(500);
        const { result } = await run.finish();
        const hostIds = result.hostSpans.map((s: SpanRec) => s.spanId).sort();
        const storeIds = result.storeSpans.map((s: SpanRec) => s.spanId).sort();
        console.log(
          `[Q2 ${host.format}/${adapter}] host exporter ${hostIds.length}, store ${storeIds.length}, stats`,
          JSON.stringify(result.storeStats),
          "names",
          result.storeSpans.map((s: SpanRec) => s.name).join(", "),
        );
        expect(storeIds).toEqual(hostIds);
        // The host's own spans are in the store, not only Nestrix's.
        const scopes = new Set(result.storeSpans.map((s: SpanRec) => s.scope));
        expect(scopes.has("host-app")).toBe(true);
        expect(scopes.has("nestrix-standin")).toBe(true);
        expect(
          result.storeSpans.some((s: SpanRec) => s.name === "host.startup"),
        ).toBe(true);
        expect(result.storeSpans.some((s: SpanRec) => s.name === "GET")).toBe(
          true,
        ); // 404: no route, named by method alone
        assertChain(result.storeSpans, JSON.parse(res.body));
        expect(result.storeStats.faults).toBe(0);
      });
    }
  }

  it("sampled out by the host: the store sees nothing (cjs, express)", async () => {
    const run = await startScenario(scenario("host-sdk3-cjs.cjs"), {
      S3_STORE: "1",
      S3_SAMPLER: "off",
    });
    for (let i = 0; i < 5; i++) {
      expect((await run.get("/hello")).status).toBe(200);
    }
    const { result } = await run.finish();
    console.log(
      "[Q2 sampler off] host spans",
      result.hostSpans.length,
      "store stats",
      JSON.stringify(result.storeStats),
    );
    expect(result.hostSpans).toEqual([]);
    expect(result.storeStats).toEqual({
      started: 0,
      ended: 0,
      dropped: 0,
      faults: 0,
    });
    // Spans are non-recording (updateName does nothing on them), yet the route is
    // known: it lives in Nestrix's own request state, counted before sampling.
    expect(result.routeStats).toEqual({ "GET /hello": 5 });
  });

  it("fault: the store throws on every add; host and request unaffected (cjs, express)", async () => {
    const run = await startScenario(scenario("host-sdk3-cjs.cjs"), {
      S3_STORE: "1",
      S3_STORE_FAULT: "store",
    });
    const res = await run.get("/s3/work", { traceparent: TRACEPARENT });
    expect(res.status).toBe(200);
    const { result } = await run.finish();
    console.log(
      "[Q2 store fault] host spans",
      result.hostSpans.length,
      "store stats",
      JSON.stringify(result.storeStats),
    );
    expect(result.storeSpans).toEqual([]);
    expect(result.storeStats.faults).toBe(result.storeStats.ended);
    expect(result.storeStats.faults).toBeGreaterThan(0);
    assertChain(result.hostSpans, JSON.parse(res.body));
  });

  it("control: an unguarded throwing processor breaks the host (cjs, express)", async () => {
    const run = await startScenario(scenario("host-sdk3-cjs.cjs"), {
      S3_STORE: "1",
      S3_NAIVE_THROW: "1",
    });
    const res = await run.get("/s3/work", { traceparent: TRACEPARENT });
    const { result } = await run.finish();
    console.log(
      "[Q2 naive throw] /s3/work status",
      res.status,
      "errors",
      JSON.stringify(result.errors),
      "host spans",
      result.hostSpans.length,
      "store stats",
      JSON.stringify(result.storeStats),
      "nestrix faults",
      JSON.stringify(result.faults),
    );
    // The SDK does not guard processor calls: host.startup threw into host code...
    expect(result.errors[0]).toMatch(/naive processor: onStart/);
    // ...the host's own startActiveSpan in the handler threw, failing the request...
    expect(res.status).toBe(500);
    // ...Nestrix's request hook caught the same throw from startSpan and still
    // called done()...
    expect(result.faults.requestHook).toBe(1);
    // ...and the processor listed after the throwing one never ran.
    expect(result.storeStats.started).toBe(0);
  });
});

describe("Rule 1: a Nestrix hook that throws does not change the request", () => {
  for (const fault of ["request-hook", "route-hook", "http-subscriber"]) {
    for (const adapter of adapters) {
      it(`${fault} on ${adapter}`, async () => {
        const run = await startScenario(scenario("host-sdk3-esm.mjs"), {
          S3_ADAPTER: adapter,
          S3_FAULT: fault,
        });
        const res = await run.get("/s3/work");
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.fetchStatus).toBe(200);
        expect(body.httpStatus).toBe(200);
        const { result } = await run.finish();
        const key = {
          "request-hook": "requestHook",
          "route-hook": "routeHook",
          "http-subscriber": "httpSubscriber",
        }[fault] as string;
        console.log(
          `[fault ${fault}/${adapter}]`,
          JSON.stringify(result.faults),
        );
        expect(result.faults[key]).toBeGreaterThan(0);
      });
    }
  }
});
