// Global state: no host SDK; Nestrix owns the provider (export off), one app at a time. The
// method call sink is process-global: the dashboard installs it at mount and removes it at
// shutdown. The test feeds the sink directly (the level 2 wrappers are P3-02's).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDiagnosticsForTests } from "../src/diagnostics.js";
import { getMethodCallSink } from "../src/methods/sink.js";
import type { ClassStatsResponse } from "../src/store/protocol-types.js";
import { getStore } from "../src/store/store.js";
import {
  ADAPTERS,
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  headerProblems,
  TOKEN,
} from "./dashboard-fixture.js";
import { fakeSpan, spanId } from "./store-helpers.js";

let booted: DashboardApp | undefined;

beforeEach(() => resetDiagnosticsForTests());
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const NESTRIX = {
  export: { otlp: false as const },
  ui: { enabled: true, auth: { token: TOKEN } },
};

describe.each(ADAPTERS)("GET api/v1/classes on %s", (adapter) => {
  it("serves the window sums of calls fed to the sink; the sink goes away with the app", async () => {
    booted = await bootDashboardApp({ adapter, nestrix: NESTRIX });
    const url = `${booted.baseUrl}/_nestrix/api/v1/classes`;

    // Nothing recorded yet.
    const empty = await get(url, BEARER);
    expect(empty.status).toBe(200);
    expect(headerProblems(empty)).toEqual([]);
    expect(empty.json()).toMatchObject({
      windowMinutes: 15,
      methodsEnabled: false,
      classes: [],
    });

    const sink = getMethodCallSink();
    expect(sink).toBeDefined();
    sink?.record("OrdersService", "service", "place", 40, false);
    sink?.record("OrdersService", "service", "place", 60, true);
    sink?.record("OrdersService", "service", "cancel", 5, false);
    sink?.record("OrdersRepository", "repository", "save", 500, false);

    const r = await get(`${url}?windowMinutes=60`, BEARER);
    expect(r.status).toBe(200);
    const body = r.json() as ClassStatsResponse;
    expect(body.windowMinutes).toBe(60);
    // No NestrixInstrument in this app: the sink was fed directly, so method spans are off.
    expect(body.methodsEnabled).toBe(false);
    expect(body.toUnixMs).toBeGreaterThan(body.fromUnixMs);
    expect(body.classes.map((c) => c.className)).toEqual([
      "OrdersRepository",
      "OrdersService",
    ]);
    const orders = body.classes[1];
    expect(orders).toMatchObject({
      kind: "service",
      calls: 3,
      errors: 1,
      totalMs: 105,
      ownMs: null,
    });
    expect(orders?.methods[0]).toMatchObject({
      method: "place",
      calls: 2,
      errors: 1,
      totalMs: 100,
      avgMs: 50,
      maxMs: 60,
      ownAvgMs: null,
    });

    await booted.close();
    booted = undefined;
    expect(getMethodCallSink()).toBeUndefined();
  });

  it("requires the dashboard's authentication and validates windowMinutes", async () => {
    booted = await bootDashboardApp({ adapter, nestrix: NESTRIX });
    const url = `${booted.baseUrl}/_nestrix/api/v1/classes`;
    expect((await get(url)).status).not.toBe(200);
    const bad = await get(`${url}?windowMinutes=30`, BEARER);
    expect(bad.status).toBe(400);
    expect(bad.json()).toEqual({
      error: {
        code: "bad_request",
        message: 'Query parameter "windowMinutes" must be one of 15, 60.',
      },
    });
    expect((await get(`${url}?x=1`, BEARER)).status).toBe(400);
  });
});

describe("own time from the store", () => {
  it("fills ownAvgMs and ownMs from sampled method spans", async () => {
    booted = await bootDashboardApp({ adapter: "express", nestrix: NESTRIX });
    const store = getStore();
    expect(store).toBeDefined();
    const now = Date.now();
    const parent = spanId();
    store?.enqueue(
      fakeSpan({
        trace: 9,
        parent: { spanId: parent },
        kind: 2,
        startMs: now,
        durationMs: 30,
      }),
    );
    store?.enqueue(
      fakeSpan({
        trace: 9,
        id: parent,
        startMs: now,
        durationMs: 100,
        attributes: {
          "nestrix.class": "OrdersService",
          "nestrix.method": "place",
        },
      }),
    );
    store?.drainNow();
    const sink = getMethodCallSink();
    for (let i = 0; i < 4; i++) {
      sink?.record("OrdersService", "service", "place", 100, false);
    }
    sink?.record("OrdersService", "service", "cancel", 5, false);

    const r = await get(`${booted.baseUrl}/_nestrix/api/v1/classes`, BEARER);
    const body = r.json() as ClassStatsResponse;
    const orders = body.classes[0];
    const place = orders?.methods.find((m) => m.method === "place");
    expect(place?.ownAvgMs).toBe(70);
    expect(
      orders?.methods.find((m) => m.method === "cancel")?.ownAvgMs,
    ).toBeNull();
    // Estimated from sampled spans, scaled by the counted calls: 70 * 4.
    expect(orders?.ownMs).toBe(280);
  });
});
