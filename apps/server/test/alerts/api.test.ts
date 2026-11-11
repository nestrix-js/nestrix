/**
 * `/api/v1/alerts` on the whole server (admin login, storage, alerts) against a real PostgreSQL,
 * and the acceptance check end to end: a rule created through the API fires once with one signed
 * webhook to a local receiver and resolves when the error rate drops.
 */
import "reflect-metadata";
import type {
  AlertEventListResponse,
  AlertRule,
  AlertRuleCreateResponse,
  AlertRuleListResponse,
  AlertTestResponse,
} from "@nestrix/protocol";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlertEvaluator } from "../../src/alerts/evaluator.js";
import { STORAGE_POOL } from "../../src/storage/storage.module.js";
import { corsHeaders, rawRequest } from "../auth/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import {
  type AlertsServer,
  type Receiver,
  seedMinute,
  startAlertsServer,
  startReceiver,
  verifySignature,
} from "./helpers.js";

describe.skipIf(noDatabase)(`alerts API ${skipReason}`, () => {
  let db: TestDb;
  let server: AlertsServer;
  let receiver: Receiver;

  const rule = (over: Record<string, unknown> = {}) => ({
    name: "Shop errors",
    service: "shop",
    metric: "error_rate",
    threshold: 0.1,
    windowMinutes: 5,
    forMinutes: 0,
    webhookUrl: receiver.url,
    ...over,
  });

  async function create(
    over: Record<string, unknown> = {},
  ): Promise<AlertRuleCreateResponse> {
    const res = await server.call("POST", "/api/v1/alerts", rule(over));
    expect(res.status).toBe(201);
    return (await res.json()) as AlertRuleCreateResponse;
  }

  beforeAll(async () => {
    db = await createTestDb("alerts_api");
    receiver = await startReceiver();
    server = await startAlertsServer(db.url, {
      NESTRIX_WEBHOOK_ALLOWED_HOSTS: "127.0.0.1",
      NESTRIX_PUBLIC_URL: "https://obs.example.com",
    });
  });

  afterAll(async () => {
    await server?.close();
    await receiver?.close();
    await db?.drop();
  });

  describe("access", () => {
    it.each([
      ["GET", "/api/v1/alerts"],
      ["GET", "/api/v1/alerts/1"],
      ["GET", "/api/v1/alerts/events"],
      ["POST", "/api/v1/alerts"],
      ["PATCH", "/api/v1/alerts/1"],
      ["DELETE", "/api/v1/alerts/1"],
      ["POST", "/api/v1/alerts/1/test"],
    ])("%s %s answers 401 when signed out", async (method, path) => {
      const res = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers: { origin: server.origin, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(rule()) }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
      expect(corsHeaders(res.headers)).toEqual([]);
    });

    it("a state-changing request without a same-origin Origin is refused, even signed in", async () => {
      for (const origin of [undefined, "https://evil.example", "null"]) {
        const res = await fetch(`${server.baseUrl}/api/v1/alerts`, {
          method: "POST",
          headers: {
            cookie: server.cookie,
            "content-type": "application/json",
            ...(origin === undefined ? {} : { origin }),
          },
          body: JSON.stringify(rule()),
        });
        expect(res.status, String(origin)).toBe(403);
      }
      const list = (await (
        await server.call("GET", "/api/v1/alerts")
      ).json()) as AlertRuleListResponse;
      expect(list.rules).toEqual([]);
    });

    it("a cross-site request is refused and a preflight gets no CORS headers", async () => {
      const cross = await rawRequest(server.baseUrl, "GET", "/api/v1/alerts", {
        cookie: server.cookie,
        "sec-fetch-site": "cross-site",
      });
      expect(cross.status).toBe(403);
      const preflight = await rawRequest(
        server.baseUrl,
        "OPTIONS",
        "/api/v1/alerts",
        {
          origin: "https://evil.example",
          "access-control-request-method": "POST",
        },
      );
      expect(preflight.status).toBeGreaterThanOrEqual(400);
      expect(corsHeaders(preflight.headers)).toEqual([]);
    });
  });

  describe("rules", () => {
    it("create returns the secret once; nothing else ever does", async () => {
      const created = await create({ name: "Secret check" });
      expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      expect(created.rule).toMatchObject({
        name: "Secret check",
        service: "shop",
        route: null,
        metric: "error_rate",
        comparator: ">",
        threshold: 0.1,
        windowMinutes: 5,
        forMinutes: 0,
        minRequests: 10,
        webhookUrl: receiver.url,
        enabled: true,
        state: { state: "ok", sinceUnixMs: null },
      });
      expect(JSON.stringify(created.rule)).not.toContain(created.secret);
      const id = created.rule.id;
      for (const path of [
        "/api/v1/alerts",
        `/api/v1/alerts/${id}`,
        "/api/v1/alerts/events",
      ]) {
        const text = await (await server.call("GET", path)).text();
        expect(text, path).not.toContain(created.secret);
        expect(text, path).not.toContain("whsec_");
      }
      const patched = await server.call("PATCH", `/api/v1/alerts/${id}`, {
        threshold: 0.2,
      });
      expect(await patched.text()).not.toContain("whsec_");
    });

    it("defaults forMinutes to 2", async () => {
      const { rule: r } = await create({ forMinutes: undefined });
      expect(r.forMinutes).toBe(2);
    });

    it.each([
      [{ extra: true }, /Unknown field/],
      [{ windowMinutes: 2 }, /5 to 60/],
      [{ threshold: 1.5 }, /fraction/],
      [{ metric: "p99" }, /metric/],
      [{ webhookUrl: "http://10.0.0.1/hook" }, /private/],
      [{ webhookUrl: "http://[::1]/hook" }, /loopback/],
      [{ webhookUrl: "ftp://example.com/" }, /http or https/],
    ])("refuses %j with 400", async (over, message) => {
      const res = await server.call("POST", "/api/v1/alerts", rule(over));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(message);
    });

    it("refuses a body that is not a JSON object", async () => {
      for (const body of ["[1]", '"x"', "null", "{bad json"]) {
        const res = await server.call("POST", "/api/v1/alerts", body);
        expect(res.status, body).toBe(400);
      }
      const form = await server.call("POST", "/api/v1/alerts", undefined, {
        "content-type": "text/plain",
      });
      expect(form.status).toBe(400);
    });

    it("gets, updates and deletes a rule; bad and unknown ids are 400 and 404", async () => {
      const { rule: r } = await create({ name: "CRUD" });
      const got = (await (
        await server.call("GET", `/api/v1/alerts/${r.id}`)
      ).json()) as AlertRule;
      expect(got.name).toBe("CRUD");

      const res = await server.call("PATCH", `/api/v1/alerts/${r.id}`, {
        threshold: 0.3,
        route: "/orders",
        enabled: false,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        threshold: 0.3,
        route: "/orders",
        enabled: false,
      });
      expect(
        // Checked against the stored metric (error_rate): not a fraction.
        (
          await server.call("PATCH", `/api/v1/alerts/${r.id}`, {
            threshold: 5,
          })
        ).status,
      ).toBe(400);
      expect(
        (await server.call("PATCH", `/api/v1/alerts/${r.id}`, { bogus: 1 }))
          .status,
      ).toBe(400);

      expect((await server.call("GET", "/api/v1/alerts/abc")).status).toBe(400);
      expect((await server.call("GET", "/api/v1/alerts/0")).status).toBe(400);
      expect((await server.call("GET", "/api/v1/alerts/99999999")).status).toBe(
        404,
      );
      expect(
        (await server.call("PATCH", "/api/v1/alerts/99999999", { name: "x" }))
          .status,
      ).toBe(404);

      expect(
        (await server.call("DELETE", `/api/v1/alerts/${r.id}`)).status,
      ).toBe(204);
      expect(
        (await server.call("DELETE", `/api/v1/alerts/${r.id}`)).status,
      ).toBe(404);
      expect((await server.call("GET", `/api/v1/alerts/${r.id}`)).status).toBe(
        404,
      );
    });

    it("concurrent PATCHes cannot leave a threshold that does not suit the metric", async () => {
      const pool = server.app.get<Pool>(STORAGE_POOL);
      const ids: string[] = [];
      // Each rule starts as p95_ms 0.5; one PATCH switches the metric (valid against 0.5), the
      // other sets a threshold valid for p95_ms only. Applied together they must not both stick.
      for (let i = 0; i < 12; i++) {
        ids.push((await create({ metric: "p95_ms", threshold: 0.5 })).rule.id);
      }
      const results = await Promise.all(
        ids.flatMap((id) => [
          server.call("PATCH", `/api/v1/alerts/${id}`, {
            metric: "error_rate",
          }),
          server.call("PATCH", `/api/v1/alerts/${id}`, { threshold: 5000 }),
        ]),
      );
      for (const res of results) expect([200, 400]).toContain(res.status);
      const { rows } = await pool.query<{ metric: string; threshold: number }>(
        "SELECT metric, threshold FROM alert_rules WHERE id = ANY($1::bigint[])",
        [ids],
      );
      expect(rows).toHaveLength(12);
      for (const row of rows) {
        expect(
          row.metric === "error_rate"
            ? row.threshold >= 0 && row.threshold < 1
            : row.threshold > 0 && row.threshold <= 3_600_000,
        ).toBe(true);
      }
      // The database refuses the combination by itself.
      await expect(
        pool.query(
          "UPDATE alert_rules SET metric = 'error_rate', threshold = 5000 WHERE id = $1",
          [ids[0]],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("test-send delivers one signed test notification and records it", async () => {
      const { rule: r, secret } = await create({ name: "Test send" });
      const before = receiver.requests.length;
      const res = await server.call("POST", `/api/v1/alerts/${r.id}/test`);
      expect(res.status).toBe(200);
      const { event } = (await res.json()) as AlertTestResponse;
      expect(event).toMatchObject({
        ruleId: r.id,
        kind: "test",
        delivery: "sent",
        attempts: 1,
        responseStatus: 200,
        error: null,
      });
      expect(receiver.requests).toHaveLength(before + 1);
      const hook = receiver.requests.at(-1);
      expect(hook && verifySignature(hook, secret)).toBe(true);
      expect(JSON.parse(hook?.body ?? "")).toMatchObject({
        eventId: event.id,
        state: "test",
        service: "shop",
      });
      expect(hook?.headers["x-nestrix-delivery"]).toBe(event.id);

      const list = (await (
        await server.call("GET", `/api/v1/alerts/events?rule=${r.id}&limit=5`)
      ).json()) as AlertEventListResponse;
      expect(list.events.map((e) => e.id)).toEqual([event.id]);
      expect(
        (await server.call("POST", "/api/v1/alerts/99999999/test")).status,
      ).toBe(404);
    });

    it("validates the events query", async () => {
      for (const q of [
        "limit=0",
        "limit=201",
        "rule=x",
        "x=1",
        "limit=1&limit=2",
      ]) {
        expect(
          (await server.call("GET", `/api/v1/alerts/events?${q}`)).status,
          q,
        ).toBe(400);
      }
    });
  });

  it("acceptance: fires once with one signed webhook, then resolves with one more", async () => {
    const { rule: r, secret } = await create({
      name: "Acceptance",
      service: "checkout",
      forMinutes: 0,
    });
    const pool = server.app.get(STORAGE_POOL);
    const evaluator = server.app.get(AlertEvaluator);
    const now = Date.now();
    await seedMinute(pool, {
      minuteMs: now,
      service: "checkout",
      count: 100,
      errors: 40,
    });
    const before = receiver.requests.length;

    const first = await evaluator.runOnce();
    expect(await Promise.all(first.deliveries)).toHaveLength(1);
    // Still breaching: nothing new.
    const second = await evaluator.runOnce();
    expect(second.deliveries).toHaveLength(0);
    expect(receiver.requests).toHaveLength(before + 1);
    const fired = receiver.requests.at(-1);
    expect(fired && verifySignature(fired, secret)).toBe(true);
    expect(fired?.headers["x-nestrix-delivery"]).toBe(
      JSON.parse(fired?.body ?? "").eventId,
    );
    expect(JSON.parse(fired?.body ?? "")).toMatchObject({
      rule: { id: r.id, name: "Acceptance" },
      state: "firing",
      value: 0.4,
      threshold: 0.1,
      service: "checkout",
      url: "https://obs.example.com/",
    });
    const firing = (await (
      await server.call("GET", `/api/v1/alerts/${r.id}`)
    ).json()) as AlertRule;
    expect(firing.state.state).toBe("firing");

    // The error rate drops: the same minute now holds 100 requests and 1 error.
    await seedMinute(pool, {
      minuteMs: now,
      service: "checkout",
      count: 100,
      errors: 1,
    });
    const third = await evaluator.runOnce();
    expect(await Promise.all(third.deliveries)).toHaveLength(1);
    expect(receiver.requests).toHaveLength(before + 2);
    const resolved = receiver.requests.at(-1);
    expect(resolved && verifySignature(resolved, secret)).toBe(true);
    expect(JSON.parse(resolved?.body ?? "")).toMatchObject({
      state: "resolved",
      value: 0.01,
    });

    const events = (await (
      await server.call("GET", `/api/v1/alerts/events?rule=${r.id}`)
    ).json()) as AlertEventListResponse;
    expect(events.events.map((e) => [e.kind, e.delivery])).toEqual([
      ["resolved", "sent"],
      ["firing", "sent"],
    ]);
  });
});
