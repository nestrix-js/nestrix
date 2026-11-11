/**
 * `/api/v1/slos` on the whole server against a real PostgreSQL: access rules, CRUD, statuses
 * computed from seeded `route_minutes` (availability and latency, 7 and 30 days), and a
 * burn-rate alert rule that fires through the alerting engine with a signed webhook.
 */
import "reflect-metadata";
import type {
  AlertRule,
  AlertRuleCreateResponse,
  Slo,
  SloListResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlertEvaluator } from "../../src/alerts/evaluator.js";
import { ensurePartitions, utcDay } from "../../src/storage/partitions.js";
import { STORAGE_POOL } from "../../src/storage/storage.module.js";
import {
  type AlertsServer,
  type Receiver,
  seedMinute,
  startAlertsServer,
  startReceiver,
  verifySignature,
} from "../alerts/helpers.js";
import { corsHeaders, rawRequest } from "../auth/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe.skipIf(noDatabase)(`SLO API ${skipReason}`, () => {
  let db: TestDb;
  let server: AlertsServer;
  let receiver: Receiver;

  const create = async (body: Record<string, unknown>): Promise<Slo> => {
    const res = await server.call("POST", "/api/v1/slos", body);
    expect(res.status).toBe(201);
    return (await res.json()) as Slo;
  };

  beforeAll(async () => {
    db = await createTestDb("slos_api");
    receiver = await startReceiver();
    server = await startAlertsServer(db.url, {
      NESTRIX_WEBHOOK_ALLOWED_HOSTS: "127.0.0.1",
    });
    const now = Date.now();
    await ensurePartitions(
      db.pool,
      [0, 3, 20].map((d) => utcDay(now - d * DAY)),
    );
  });

  afterAll(async () => {
    await server?.close();
    await receiver?.close();
    await db?.drop();
  });

  describe("access", () => {
    it.each([
      ["GET", "/api/v1/slos"],
      ["GET", "/api/v1/slos/1"],
      ["POST", "/api/v1/slos"],
      ["PATCH", "/api/v1/slos/1"],
      ["DELETE", "/api/v1/slos/1"],
    ])("%s %s answers 401 when signed out", async (method, path) => {
      const res = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers: { origin: server.origin, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect(res.status).toBe(401);
      expect(corsHeaders(res.headers)).toEqual([]);
    });

    it("a write without a same-origin Origin is 403, even signed in, and stores nothing", async () => {
      for (const origin of [undefined, "https://evil.example", "null"]) {
        const res = await fetch(`${server.baseUrl}/api/v1/slos`, {
          method: "POST",
          headers: {
            cookie: server.cookie,
            "content-type": "application/json",
            ...(origin === undefined ? {} : { origin }),
          },
          body: JSON.stringify({
            name: "x",
            service: "s",
            kind: "availability",
            objective: 0.99,
            windowDays: 7,
          }),
        });
        expect(res.status, String(origin)).toBe(403);
      }
      const list = (await (
        await server.call("GET", "/api/v1/slos")
      ).json()) as SloListResponse;
      expect(list.slos).toEqual([]);
    });

    it("a preflight gets no CORS headers", async () => {
      const preflight = await rawRequest(
        server.baseUrl,
        "OPTIONS",
        "/api/v1/slos",
        {
          origin: "https://evil.example",
          "access-control-request-method": "POST",
        },
      );
      expect(preflight.status).toBeGreaterThanOrEqual(400);
      expect(corsHeaders(preflight.headers)).toEqual([]);
    });
  });

  describe("CRUD", () => {
    it("creates, reads, updates and deletes; bad input is 400, unknown ids 404", async () => {
      const slo = await create({
        name: "Orders",
        service: "crud",
        route: "/orders",
        kind: "latency",
        latencyThresholdMs: 250,
        objective: 0.99,
        windowDays: 7,
      });
      expect(slo).toMatchObject({
        name: "Orders",
        service: "crud",
        route: "/orders",
        kind: "latency",
        latencyThresholdMs: 250,
        objective: 0.99,
        windowDays: 7,
        status: { totalRequests: 0, attainment: null, breached: false },
      });
      const got = await server.call("GET", `/api/v1/slos/${slo.id}`);
      expect(got.status).toBe(200);
      expect(got.headers.get("cache-control")).toBe("no-store");

      const patched = await server.call("PATCH", `/api/v1/slos/${slo.id}`, {
        objective: 0.95,
        windowDays: 30,
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        objective: 0.95,
        windowDays: 30,
        latencyThresholdMs: 250,
      });
      // To availability: the threshold goes away.
      const avail = await server.call("PATCH", `/api/v1/slos/${slo.id}`, {
        kind: "availability",
      });
      expect(await avail.json()).toMatchObject({
        kind: "availability",
        latencyThresholdMs: null,
      });

      for (const body of [
        { objective: 1 },
        { windowDays: 14 },
        { nope: true },
      ]) {
        const bad = await server.call("PATCH", `/api/v1/slos/${slo.id}`, body);
        expect(bad.status).toBe(400);
      }
      expect(
        (await server.call("POST", "/api/v1/slos", { name: "x" })).status,
      ).toBe(400);
      expect((await server.call("GET", "/api/v1/slos/abc")).status).toBe(400);
      expect((await server.call("GET", "/api/v1/slos/999999")).status).toBe(
        404,
      );

      expect(
        (await server.call("DELETE", `/api/v1/slos/${slo.id}`)).status,
      ).toBe(204);
      expect((await server.call("GET", `/api/v1/slos/${slo.id}`)).status).toBe(
        404,
      );
      expect(
        (await server.call("DELETE", `/api/v1/slos/${slo.id}`)).status,
      ).toBe(404);
    });
  });

  describe("status from seeded rollups", () => {
    it("availability over 7 and 30 days: attainment, budget and burn rates", async () => {
      const now = Date.now();
      const seed = (agoMs: number, count: number, errors: number) =>
        seedMinute(db.pool, {
          minuteMs: now - agoMs,
          service: "avail",
          count,
          errors,
        });
      await seed(10 * MIN, 1000, 100); // in 1 h, 6 h, 7 d, 30 d
      await seed(3 * HOUR, 1000, 0); // in 6 h, 7 d, 30 d
      await seed(3 * DAY, 2000, 0); // in 7 d, 30 d
      await seed(20 * DAY, 6000, 0); // in 30 d only
      // Another service and another route of the same service must not count.
      await seedMinute(db.pool, {
        minuteMs: now - 10 * MIN,
        service: "elsewhere",
        count: 5000,
        errors: 5000,
      });
      await seedMinute(db.pool, {
        minuteMs: now - 10 * MIN,
        service: "avail",
        route: "/other",
        count: 4000,
        errors: 0,
      });

      const base = {
        name: "Availability",
        service: "avail",
        route: "/orders",
        kind: "availability",
        objective: 0.95,
      };
      const d7 = await create({ ...base, windowDays: 7 });
      const d30 = await create({ ...base, windowDays: 30 });

      expect(d7.status.totalRequests).toBe(4000);
      expect(d7.status.badRequests).toBe(100);
      expect(d7.status.attainment).toBeCloseTo(0.975, 9);
      expect(d7.status.errorBudget.totalRequests).toBeCloseTo(200, 9);
      expect(d7.status.errorBudget.remainingRequests).toBeCloseTo(100, 9);
      expect(d7.status.errorBudget.remainingFraction).toBeCloseTo(0.5, 9);
      expect(d7.status.breached).toBe(false);
      // 1 h: 100/1000 = 0.1 bad, allowed 0.05. 6 h: 100/2000 = 0.05.
      expect(d7.status.burnRate["1h"]).toBeCloseTo(2, 9);
      expect(d7.status.burnRate["6h"]).toBeCloseTo(1, 9);

      expect(d30.status.totalRequests).toBe(10000);
      expect(d30.status.attainment).toBeCloseTo(0.99, 9);
      expect(d30.status.errorBudget.totalRequests).toBeCloseTo(500, 9);
      expect(d30.status.errorBudget.remainingRequests).toBeCloseTo(400, 9);
      expect(d30.status.errorBudget.remainingFraction).toBeCloseTo(0.8, 9);
      expect(d30.status.burnRate["1h"]).toBeCloseTo(2, 9);

      // The list carries the same computed status; a service-wide SLO adds the other route.
      const wide = await create({
        ...base,
        route: null,
        name: "Whole service",
        windowDays: 7,
      });
      expect(wide.status.totalRequests).toBe(8000);
      const list = (await (
        await server.call("GET", "/api/v1/slos")
      ).json()) as SloListResponse;
      const listed = list.slos.find((s) => s.id === d7.id);
      expect(listed?.status).toEqual(d7.status);
    });

    it("an overspent budget is negative and the SLO is breached", async () => {
      await seedMinute(db.pool, {
        minuteMs: Date.now() - 5 * MIN,
        service: "overspent",
        count: 1000,
        errors: 50,
      });
      const slo = await create({
        name: "Strict",
        service: "overspent",
        kind: "availability",
        objective: 0.99,
        windowDays: 7,
      });
      expect(slo.status.attainment).toBeCloseTo(0.95, 9);
      expect(slo.status.errorBudget.remainingRequests).toBeCloseTo(-40, 9);
      expect(slo.status.errorBudget.remainingFraction).toBeCloseTo(-4, 9);
      expect(slo.status.breached).toBe(true);
      expect(slo.status.burnRate["1h"]).toBeCloseTo(5, 9);
    });

    it("latency over 7 and 30 days, estimated from the histogram", async () => {
      const now = Date.now();
      // One duration per seeded row: GET rows are fast (10 ms), POST rows slow (5 s).
      const seed = (
        agoMs: number,
        method: string,
        count: number,
        durationMs: number,
      ) =>
        seedMinute(db.pool, {
          minuteMs: now - agoMs,
          service: "lat",
          method,
          count,
          errors: 0,
          durationMs,
        });
      await seed(10 * MIN, "GET", 90, 10);
      await seed(10 * MIN, "POST", 10, 5000);
      await seed(3 * HOUR, "GET", 100, 10);
      await seed(3 * DAY, "GET", 200, 10);
      await seed(20 * DAY, "GET", 600, 10);

      const base = {
        name: "Fast",
        service: "lat",
        kind: "latency",
        latencyThresholdMs: 100,
        objective: 0.9,
      };
      const d7 = await create({ ...base, windowDays: 7 });
      const d30 = await create({ ...base, windowDays: 30 });

      expect(d7.status.totalRequests).toBe(400);
      expect(d7.status.badRequests).toBeCloseTo(10, 9);
      expect(d7.status.attainment).toBeCloseTo(0.975, 9);
      expect(d7.status.errorBudget.totalRequests).toBeCloseTo(40, 9);
      expect(d7.status.errorBudget.remainingRequests).toBeCloseTo(30, 9);
      expect(d7.status.errorBudget.remainingFraction).toBeCloseTo(0.75, 9);
      expect(d7.status.burnRate["1h"]).toBeCloseTo(1, 9); // 10/100 over 0.1
      expect(d7.status.burnRate["6h"]).toBeCloseTo(0.5, 9); // 10/200 over 0.1

      expect(d30.status.totalRequests).toBe(1000);
      expect(d30.status.attainment).toBeCloseTo(0.99, 9);
      expect(d30.status.errorBudget.remainingFraction).toBeCloseTo(0.9, 9);
    });
  });

  describe("burn-rate alerts", () => {
    it("rejects an unknown SLO and a missing sloId", async () => {
      const rule = {
        name: "Burn",
        metric: "slo_burn_rate",
        threshold: 14.4,
        windowMinutes: 60,
        webhookUrl: receiver.url,
      };
      const unknown = await server.call("POST", "/api/v1/alerts", {
        ...rule,
        sloId: "999999",
      });
      expect(unknown.status).toBe(400);
      const missing = await server.call("POST", "/api/v1/alerts", rule);
      expect(missing.status).toBe(400);
    });

    it("fires through the engine with a signed webhook, resolves, and dies with its SLO", async () => {
      const slo = await create({
        name: "Burn target",
        service: "burn",
        kind: "availability",
        objective: 0.99,
        windowDays: 30,
      });
      const res = await server.call("POST", "/api/v1/alerts", {
        name: "Fast burn",
        metric: "slo_burn_rate",
        sloId: slo.id,
        threshold: 14.4,
        windowMinutes: 60,
        forMinutes: 0,
        webhookUrl: receiver.url,
      });
      expect(res.status).toBe(201);
      const { rule, secret } = (await res.json()) as AlertRuleCreateResponse;
      expect(rule).toMatchObject({
        metric: "slo_burn_rate",
        sloId: slo.id,
        service: "burn",
        route: null,
      });

      const pool = server.app.get(STORAGE_POOL);
      const evaluator = server.app.get(AlertEvaluator);
      const minuteMs = Date.now() - 5 * MIN;
      // Calm: 1% errors burns at exactly 1x.
      await seedMinute(pool, {
        minuteMs,
        service: "burn",
        count: 100,
        errors: 1,
      });
      const calm = await evaluator.runOnce();
      expect(calm.deliveries).toHaveLength(0);
      const before = receiver.requests.length;

      // 20% errors over a 1% allowance is a burn rate of 20, above 14.4.
      await seedMinute(pool, {
        minuteMs,
        service: "burn",
        count: 100,
        errors: 20,
      });
      const fired = await evaluator.runOnce();
      expect(await Promise.all(fired.deliveries)).toHaveLength(1);
      expect(receiver.requests).toHaveLength(before + 1);
      const hook = receiver.requests.at(-1);
      expect(hook && verifySignature(hook, secret)).toBe(true);
      const payload = JSON.parse(hook?.body ?? "");
      expect(payload).toMatchObject({
        rule: { id: rule.id, metric: "slo_burn_rate" },
        state: "firing",
        threshold: 14.4,
        window: { minutes: 60 },
        service: "burn",
      });
      expect(payload.value).toBeCloseTo(20, 9);
      const state = (await (
        await server.call("GET", `/api/v1/alerts/${rule.id}`)
      ).json()) as AlertRule;
      expect(state.state.state).toBe("firing");

      await seedMinute(pool, {
        minuteMs,
        service: "burn",
        count: 100,
        errors: 1,
      });
      const resolved = await evaluator.runOnce();
      expect(await Promise.all(resolved.deliveries)).toHaveLength(1);
      expect(JSON.parse(receiver.requests.at(-1)?.body ?? "")).toMatchObject({
        state: "resolved",
      });

      // Deleting the SLO deletes the rules that burn on it.
      expect(
        (await server.call("DELETE", `/api/v1/slos/${slo.id}`)).status,
      ).toBe(204);
      expect(
        (await server.call("GET", `/api/v1/alerts/${rule.id}`)).status,
      ).toBe(404);
    });
  });
});
