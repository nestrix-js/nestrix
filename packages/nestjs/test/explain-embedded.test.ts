// P12-01: `GET api/v1/routes/explain` on the embedded dashboard. The handler is driven with a real
// store; one HTTP test checks the mounted route (shape, headers, closed without a token).
import type { RouteExplainResponse } from "@nestrix-js/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApiSources, routeExplainHandler } from "../src/dashboard/api.js";
import { resetDiagnosticsForTests } from "../src/diagnostics.js";
import { MAX_SPANS_PER_SIDE, trimSpans } from "../src/explain/embedded.js";
import { ClassStatistics } from "../src/stats/class-stats.js";
import { RouteStatistics } from "../src/stats/route-stats.js";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import {
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  headerProblems,
  TOKEN,
} from "./dashboard-fixture.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot, spanId } from "./store-helpers.js";

const MINUTE = 60_000;
const NOW = Math.floor(1_800_000_000_000 / MINUTE) * MINUTE + 30_000;

beforeEach(() => resetStoreForTests());
afterEach(() => resetStoreForTests());

/** `GET /orders` traces: 6 fast ones before, 6 slow ones now with a repeated statement. */
function seeded(): ApiSources {
  const store = getOrCreateStore({}, recordingDiagnostics());
  store.attach({});
  const processor = createStoreProcessor(store as never);
  let n = 1;
  const request = (
    startMs: number,
    release: string,
    route: string,
    statements: number,
    failing = false,
  ) => {
    const id = spanId();
    const trace = n++;
    const resource = { "service.name": "shop", "service.version": release };
    for (let k = 0; k < statements; k++) {
      processor.onEnd(
        fakeSpan({
          trace,
          parent: { spanId: id },
          name: "SELECT",
          kind: 2,
          startMs: startMs + 2 + k * 5,
          durationMs: 4,
          attributes: {
            "db.system.name": "postgresql",
            "db.query.text": "SELECT * FROM order_items WHERE order_id = $1",
            "server.address": "db.local",
          },
          resource,
        }),
      );
    }
    processor.onEnd(
      serverRoot(trace, {
        id,
        startMs,
        durationMs: 20 + statements * 5,
        resource,
        status: failing ? { code: 2, message: "boom" } : { code: 0 },
        events: failing
          ? [
              {
                name: "exception",
                attributes: {
                  "exception.type": "PaymentGatewayError",
                  "exception.message": "card declined",
                },
              },
            ]
          : [],
        attributes: {
          "http.request.method": "GET",
          "http.route": route,
          "http.response.status_code": failing ? 500 : 200,
        },
      }),
    );
  };
  // Previous window (15 minutes: 30 s to 15 min before the last window starts): release 1.0.
  for (let i = 0; i < 6; i++)
    request(NOW - 25 * MINUTE + i * 1000, "1.0", "/orders", 0);
  // Current window: release 2.0, a statement run 4 times per request, two failures.
  for (let i = 0; i < 6; i++) {
    request(NOW - 5 * MINUTE + i * 1000, "2.0", "/orders", 4, i < 2);
  }
  // Another route, never counted.
  request(NOW - 4 * MINUTE, "2.0", "/other", 9);
  store.drainNow();
  return {
    store,
    stats: new RouteStatistics(NOW - 120 * MINUTE),
    classes: new ClassStatistics(NOW - 3 * 60 * MINUTE),
    service: { name: "shop" },
    sampling: { owner: "nestrix", rate: 1 },
    hostOwnsProvider: false,
    ignoresRoutes: false,
    fallbackProcessId: "x",
  };
}

const call = (src: ApiSources, query: string) =>
  routeExplainHandler(`/x?${query}`, src, NOW);
const ok = (src: ApiSources, query: string): RouteExplainResponse => {
  const r = call(src, query);
  expect(r.status).toBe(200);
  return JSON.parse(r.body as string) as RouteExplainResponse;
};

describe("route explain handler (embedded)", () => {
  it("explains a window change from the stored traces of one route", () => {
    const r = ok(seeded(), "method=get&route=/orders&windowMinutes=15");
    expect(r.mode).toBe("window");
    expect(r.method).toBe("GET");
    expect(r.route).toBe("/orders");
    expect(r.before).toMatchObject({
      label: "previous",
      traces: 6,
      errorRate: 0,
    });
    expect(r.after).toMatchObject({ label: "current", traces: 6 });
    expect(r.after.errorRate).toBeCloseTo(2 / 6);
    expect(r.releases).toEqual(["2.0", "1.0"]);

    const f = r.findings.map((x) => x.kind);
    expect(f).toContain("n-plus-one");
    expect(f).toContain("new-error");
    expect(r.findings[0]).toMatchObject({
      kind: "n-plus-one",
      direction: "worse",
      link: {
        view: "queries",
        params: { q: "SELECT * FROM order_items WHERE order_id = $1" },
      },
    });
    expect(r.statements[0]).toMatchObject({
      statement: "SELECT * FROM order_items WHERE order_id = $1",
      system: "postgresql",
      beforeCalls: 0,
      afterCalls: 4,
    });
    expect(r.dependencies[0]).toMatchObject({
      kind: "db",
      name: "postgresql",
      afterCalls: 4,
    });
    expect(r.errors).toEqual([
      {
        type: "PaymentGatewayError",
        message: "card declined",
        beforeTraces: 0,
        afterTraces: 2,
      },
    ]);
    expect(r.kinds.find((k) => k.key === "db")?.afterMs).toBeCloseTo(16);
    expect(r.slowest).toHaveLength(6);
    expect(r.summary).toMatch(/^Mean time went from 20 ms to 40 ms/);
  });

  it("compares two releases anywhere in the store", () => {
    const r = ok(seeded(), "route=/orders&releaseA=1.0&releaseB=2.0");
    expect(r.mode).toBe("release");
    expect(r.method).toBeNull();
    expect(r.before).toMatchObject({ label: "1.0", traces: 6 });
    expect(r.after).toMatchObject({ label: "2.0", traces: 6 });
    expect(r.findings.map((x) => x.kind)).toContain("n-plus-one");
    // An unknown release has no traces.
    const none = ok(seeded(), "route=/orders&releaseA=1.0&releaseB=9.9");
    expect(none.after.traces).toBe(0);
    expect(none.summary).toBe(
      "Not enough traces to compare (6 before, 0 after).",
    );
  });

  it("answers an unknown route, another service and no store without findings", () => {
    const src = seeded();
    const unknown = ok(src, "route=/nope");
    expect(unknown.before.traces + unknown.after.traces).toBe(0);
    expect(unknown.findings).toEqual([]);
    expect(unknown.releases).toEqual([]);
    const other = ok(src, "route=/orders&service=billing");
    expect(other.after.traces).toBe(0);
    expect(other.releases).toEqual([]);
    expect(
      ok(src, "route=/orders&service=shop&windowMinutes=15").after.traces,
    ).toBe(6);
    const noStore = ok({ ...src, store: undefined }, "route=/orders");
    expect(noStore.after.traces).toBe(0);
  });

  it("refuses a missing route, one release, and bad parameters", () => {
    const src = seeded();
    for (const q of [
      "",
      "route=/orders&releaseA=1.0",
      "route=/orders&releaseB=1.0",
      "route=/orders&windowMinutes=30",
      "route=/orders&nope=1",
    ]) {
      expect(call(src, q).status, q).toBe(400);
    }
  });
});

let booted: DashboardApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  resetDiagnosticsForTests();
});

describe("route explain endpoint (express)", () => {
  it("is mounted, shaped, header-safe, and closed without a token", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: {
        export: { otlp: false },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
    });
    for (let i = 0; i < 3; i++) await get(`${booted.baseUrl}/h/ok`);
    const api = `${booted.baseUrl}/_nestrix/api/v1/routes/explain`;
    const res = await get(`${api}?route=/h/ok&method=GET`, BEARER);
    expect(res.status).toBe(200);
    expect(headerProblems(res)).toEqual([]);
    const body = res.json() as RouteExplainResponse;
    expect(body.mode).toBe("window");
    expect(body.route).toBe("/h/ok");
    expect(Object.keys(body).sort()).toEqual(
      [
        "mode",
        "method",
        "route",
        "before",
        "after",
        "releases",
        "findings",
        "summary",
        "kinds",
        "statements",
        "methods",
        "dependencies",
        "errors",
        "slowest",
      ].sort(),
    );
    expect(body.kinds).toHaveLength(6);
    expect((await get(`${api}?route=/h/ok&releaseA=1`, BEARER)).status).toBe(
      400,
    );
    expect((await get(api, BEARER)).status).toBe(400);
    expect((await get(`${api}?route=/h/ok`)).status).not.toBe(200);
  });
});

describe("span cap per side", () => {
  const spanInput = {
    spanId: "a",
    durationMs: 1,
    error: false,
    key: "app" as const,
    exceptions: [],
  };
  const trace = (n: number, spans: number) => ({
    traceId: `t${n}`,
    startUnixMs: n,
    durationMs: 1,
    status: 200,
    error: false,
    spans: Array.from({ length: spans }, () => spanInput),
  });

  it("drops the oldest traces until the spans fit, and keeps the newest", () => {
    const per = MAX_SPANS_PER_SIDE / 2 - 10;
    const side = {
      label: "current",
      fromUnixMs: 0,
      toUnixMs: 10,
      traces: [trace(1, per), trace(2, per), trace(3, per), trace(4, per)],
    };
    trimSpans(side);
    expect(side.traces.map((t) => t.traceId)).toEqual(["t3", "t4"]);
  });

  it("leaves a side under the cap alone, and keeps one trace even when it alone is over", () => {
    const small = {
      label: "c",
      fromUnixMs: 0,
      toUnixMs: 1,
      traces: [trace(1, 5), trace(2, 5)],
    };
    trimSpans(small);
    expect(small.traces).toHaveLength(2);
    const huge = {
      label: "c",
      fromUnixMs: 0,
      toUnixMs: 1,
      traces: [trace(1, 10), trace(2, MAX_SPANS_PER_SIDE + 1)],
    };
    trimSpans(huge);
    expect(huge.traces.map((t) => t.traceId)).toEqual(["t2"]);
  });
});
