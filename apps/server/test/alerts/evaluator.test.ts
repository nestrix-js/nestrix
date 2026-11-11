/**
 * The evaluator against a real PostgreSQL with seeded `route_minutes` rows and a controllable
 * clock: state transitions, notifications, the advisory lock across two evaluators, faults.
 */
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AlertEvaluator } from "../../src/alerts/evaluator.js";
import { WebhookSender } from "../../src/alerts/webhook.js";
import { ADVISORY_CLASS, ALERTS_LOCK } from "../../src/storage/locks.js";
import { runMigrations } from "../../src/storage/migrate.js";
import { ensurePartitions, utcDay } from "../../src/storage/partitions.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import {
  type Receiver,
  seedMinute,
  startReceiver,
  verifySignature,
} from "./helpers.js";

const MIN = 60_000;
/** A test-only signing key. */
const KEY = "t".repeat(40);

describe.skipIf(noDatabase)(`alert evaluator ${skipReason}`, () => {
  let db: TestDb;
  let receiver: Receiver;
  const senders: WebhookSender[] = [];
  // Minute-aligned, so seeded minutes and evaluation times line up exactly.
  const base = Math.floor(Date.now() / MIN) * MIN;

  function sender(allowed: string[] = ["127.0.0.1"]): WebhookSender {
    const s = new WebhookSender({
      allowedHosts: allowed,
      backoffMs: () => 10,
      timeoutMs: 1000,
    });
    senders.push(s);
    return s;
  }

  function evaluator(
    clock: { now: number },
    options: {
      pool?: pg.Pool;
      sender?: WebhookSender;
      onError?: (m: string) => void;
    } = {},
  ): AlertEvaluator {
    return new AlertEvaluator(
      options.pool ?? db.pool,
      options.sender ?? sender(),
      {
        retentionDays: 7,
        publicUrl: "https://obs.example.com",
        now: () => clock.now,
        onError: options.onError ?? (() => undefined),
      },
    );
  }

  async function insertRule(init: {
    service: string;
    route?: string | null;
    metric?: "error_rate" | "p95_ms";
    threshold?: number;
    windowMinutes?: number;
    forMinutes?: number;
    minRequests?: number;
    url?: string;
  }): Promise<number> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO alert_rules (name, service_name, route, metric, threshold, window_minutes,
         for_minutes, min_requests, webhook_url, secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        `rule for ${init.service}`,
        init.service,
        init.route ?? null,
        init.metric ?? "error_rate",
        init.threshold ?? 0.1,
        init.windowMinutes ?? 5,
        init.forMinutes ?? 2,
        init.minRequests ?? 10,
        init.url ?? receiver.url,
        KEY,
      ],
    );
    return Number(rows[0]?.id);
  }

  async function events(ruleId: number) {
    const { rows } = await db.pool.query(
      "SELECT kind, delivery, attempts, response_status, error, value FROM alert_events WHERE rule_id = $1 ORDER BY id",
      [ruleId],
    );
    return rows;
  }

  async function state(ruleId: number) {
    const { rows } = await db.pool.query(
      "SELECT state, since, last_value, last_notified_at FROM alert_state WHERE rule_id = $1",
      [ruleId],
    );
    return rows[0];
  }

  async function run(e: AlertEvaluator) {
    const r = await e.runOnce();
    const deliveries = await Promise.all(r.deliveries);
    return { ...r, deliveries };
  }

  beforeAll(async () => {
    db = await createTestDb("alerts_eval");
    await runMigrations(db.pool);
    const today = utcDay(base);
    await ensurePartitions(db.pool, [today - 1, today, today + 1]);
    receiver = await startReceiver();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM alert_rules");
    receiver.requests.length = 0;
  });

  afterAll(async () => {
    await Promise.all(senders.map((s) => s.close(1000)));
    await receiver?.close();
    await db?.drop();
  });

  it("ok -> pending -> firing (one signed webhook) -> resolved (one more)", async () => {
    const service = "shop";
    const id = await insertRule({ service, forMinutes: 2 });
    await seedMinute(db.pool, {
      minuteMs: base,
      service,
      count: 100,
      errors: 50,
    });
    const clock = { now: base };
    const e = evaluator(clock);

    expect((await run(e)).deliveries).toEqual([]);
    expect(await state(id)).toMatchObject({
      state: "pending",
      last_value: 0.5,
    });

    clock.now = base + MIN;
    expect((await run(e)).deliveries).toEqual([]);
    expect(receiver.requests).toHaveLength(0);

    clock.now = base + 2 * MIN;
    const firing = await run(e);
    expect(firing.deliveries).toEqual([
      { delivery: "sent", attempts: 1, status: 200, error: null },
    ]);
    expect(receiver.requests).toHaveLength(1);
    const hook = receiver.requests[0];
    expect(hook && verifySignature(hook, KEY)).toBe(true);
    expect(JSON.parse(hook?.body ?? "")).toEqual({
      rule: {
        id: String(id),
        name: "rule for shop",
        metric: "error_rate",
        comparator: ">",
      },
      state: "firing",
      value: 0.5,
      threshold: 0.1,
      window: { minutes: 5 },
      service,
      route: null,
      startedAt: new Date(base).toISOString(),
      sentAt: new Date(base + 2 * MIN).toISOString(),
      url: "https://obs.example.com/",
    });
    expect(await state(id)).toMatchObject({ state: "firing" });
    expect((await state(id)).last_notified_at).not.toBeNull();

    // Still breaching: no second firing notification.
    clock.now = base + 3 * MIN;
    expect((await run(e)).deliveries).toEqual([]);

    // Recovery: 1000 good requests bring the window's rate to 50 / 1100.
    await seedMinute(db.pool, {
      minuteMs: base + 4 * MIN,
      service,
      count: 1000,
      errors: 0,
    });
    clock.now = base + 4 * MIN;
    expect((await run(e)).deliveries).toHaveLength(1);
    expect(receiver.requests).toHaveLength(2);
    const resolved = JSON.parse(receiver.requests[1]?.body ?? "");
    expect(resolved).toMatchObject({
      state: "resolved",
      startedAt: new Date(base).toISOString(),
    });
    expect(resolved.value).toBeCloseTo(50 / 1100);
    expect(
      receiver.requests[1] && verifySignature(receiver.requests[1], KEY),
    ).toBe(true);
    expect(await state(id)).toMatchObject({ state: "ok" });

    clock.now = base + 5 * MIN;
    expect((await run(e)).deliveries).toEqual([]);
    expect(await events(id)).toEqual([
      expect.objectContaining({
        kind: "firing",
        delivery: "sent",
        attempts: 1,
        response_status: 200,
      }),
      expect.objectContaining({ kind: "resolved", delivery: "sent" }),
    ]);
  });

  it("respects forMinutes: a breach that ends sooner sends nothing", async () => {
    const service = "brief";
    const id = await insertRule({ service, forMinutes: 2 });
    await seedMinute(db.pool, {
      minuteMs: base,
      service,
      count: 20,
      errors: 10,
    });
    const clock = { now: base };
    const e = evaluator(clock);
    await run(e);
    expect(await state(id)).toMatchObject({ state: "pending" });
    await seedMinute(db.pool, {
      minuteMs: base + MIN,
      service,
      count: 1000,
      errors: 0,
    });
    clock.now = base + MIN;
    await run(e);
    expect(await state(id)).toMatchObject({ state: "ok" });
    clock.now = base + 2 * MIN;
    await run(e);
    expect(receiver.requests).toHaveLength(0);
    expect(await events(id)).toEqual([]);
  });

  it("fewer requests than minRequests is no data: nothing changes", async () => {
    const service = "quiet";
    const id = await insertRule({ service, forMinutes: 0, minRequests: 10 });
    await seedMinute(db.pool, { minuteMs: base, service, count: 5, errors: 5 });
    await run(evaluator({ now: base }));
    expect(await state(id)).toMatchObject({ state: "ok", last_value: null });
    expect(receiver.requests).toHaveLength(0);
  });

  it("evaluates p95 from the summed histograms, and only the rule's route", async () => {
    const service = "latency";
    const slow = await insertRule({
      service,
      metric: "p95_ms",
      threshold: 500,
      forMinutes: 0,
      route: "/slow",
    });
    const fast = await insertRule({
      service,
      metric: "p95_ms",
      threshold: 500,
      forMinutes: 0,
      route: "/fast",
    });
    await seedMinute(db.pool, {
      minuteMs: base,
      service,
      route: "/slow",
      count: 50,
      errors: 0,
      durationMs: 900,
    });
    await seedMinute(db.pool, {
      minuteMs: base,
      service,
      route: "/fast",
      count: 50,
      errors: 0,
      durationMs: 20,
    });
    const r = await run(evaluator({ now: base }));
    expect(r.deliveries).toHaveLength(1);
    expect(await state(slow)).toMatchObject({ state: "firing" });
    expect((await state(slow)).last_value).toBeGreaterThan(500);
    expect(await state(fast)).toMatchObject({ state: "ok" });
    expect((await state(fast)).last_value).toBeLessThan(500);
  });

  it("ignores minutes outside the window", async () => {
    const service = "old";
    const id = await insertRule({ service, forMinutes: 0, windowMinutes: 5 });
    await seedMinute(db.pool, {
      minuteMs: base - 5 * MIN,
      service,
      count: 100,
      errors: 100,
    });
    await seedMinute(db.pool, {
      minuteMs: base,
      service,
      count: 100,
      errors: 0,
    });
    await run(evaluator({ now: base }));
    expect(await state(id)).toMatchObject({ state: "ok", last_value: 0 });
  });

  it("two evaluators on one database send one notification (in parallel and back to back)", async () => {
    const service = "twins";
    const id = await insertRule({ service, forMinutes: 0 });
    await seedMinute(db.pool, {
      minuteMs: base,
      service,
      count: 100,
      errors: 90,
    });
    const otherPool = new (await import("pg")).default.Pool({
      connectionString: db.url,
      max: 4,
    });
    otherPool.on("error", () => undefined);
    try {
      const clock = { now: base };
      const a = evaluator(clock);
      const b = evaluator(clock, { pool: otherPool, sender: sender() });
      const [ra, rb] = await Promise.all([run(a), run(b)]);
      const rc = await run(b);
      const sent = [ra, rb, rc].flatMap((r) => r.deliveries);
      expect(sent).toHaveLength(1);
      expect(receiver.requests).toHaveLength(1);
      expect(await events(id)).toHaveLength(1);
      // At most one of the parallel runs got the lock; the other skipped.
      expect(
        [ra.skipped, rb.skipped].filter((s) => s === "locked").length,
      ).toBeLessThanOrEqual(1);
    } finally {
      await otherPool.end();
    }
  });

  it("skips the run while another instance holds the lock", async () => {
    const service = "locked";
    await insertRule({ service, forMinutes: 0 });
    await seedMinute(db.pool, {
      minuteMs: base,
      service,
      count: 100,
      errors: 90,
    });
    const holder = await db.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1, $2)", [
        ADVISORY_CLASS,
        ALERTS_LOCK,
      ]);
      const r = await run(evaluator({ now: base }));
      expect(r).toMatchObject({
        skipped: "locked",
        evaluated: 0,
        deliveries: [],
      });
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1, $2)", [
        ADVISORY_CLASS,
        ALERTS_LOCK,
      ]);
      holder.release();
    }
    expect(receiver.requests).toHaveLength(0);
  });

  it("records a refused webhook (loopback without the allowlist) and sends nothing", async () => {
    const service = "refused";
    const id = await insertRule({ service, forMinutes: 0 });
    await seedMinute(db.pool, {
      minuteMs: base,
      service,
      count: 100,
      errors: 90,
    });
    const r = await run(evaluator({ now: base }, { sender: sender([]) }));
    expect(r.deliveries).toEqual([
      {
        delivery: "refused",
        attempts: 1,
        status: null,
        error: "refused_address",
      },
    ]);
    expect(receiver.requests).toHaveLength(0);
    expect(await events(id)).toEqual([
      expect.objectContaining({
        kind: "firing",
        delivery: "refused",
        error: "refused_address",
      }),
    ]);
    expect((await state(id)).last_notified_at).toBeNull();
  });

  it("deletes history older than the retention", async () => {
    const id = await insertRule({ service: "history" });
    await db.pool.query(
      `INSERT INTO alert_events (rule_id, created_at, kind, threshold)
       VALUES ($1, $2, 'test', 0.1), ($1, $3, 'test', 0.1)`,
      [id, new Date(base - 8 * 86_400_000), new Date(base - 86_400_000)],
    );
    await run(evaluator({ now: base }));
    expect(await events(id)).toHaveLength(1);
  });

  describe("faults never escape", () => {
    it("a sender that throws, and a logger that throws", async () => {
      const service = "faulty";
      const id = await insertRule({ service, forMinutes: 0 });
      await seedMinute(db.pool, {
        minuteMs: base,
        service,
        count: 100,
        errors: 90,
      });
      const broken = sender();
      broken.send = () => {
        throw new Error("sender exploded");
      };
      const r = await run(
        evaluator(
          { now: base },
          {
            sender: broken,
            onError: () => {
              throw new Error("logger exploded");
            },
          },
        ),
      );
      expect(r.deliveries).toEqual([
        { delivery: "failed", attempts: 0, status: null, error: "internal" },
      ]);
      expect(await events(id)).toEqual([
        expect.objectContaining({ delivery: "failed", error: "internal" }),
      ]);
    });

    it("a database that cannot be reached", async () => {
      const messages: string[] = [];
      const pool = {
        connect: () => Promise.reject(new Error("connection refused")),
        query: () => Promise.reject(new Error("connection refused")),
      } as unknown as pg.Pool;
      const r = await run(
        evaluator({ now: base }, { pool, onError: (m) => messages.push(m) }),
      );
      expect(r).toEqual({ evaluated: 0, deliveries: [] });
      expect(messages).toEqual(["alert evaluation failed: connection refused"]);
    });

    it("one failing rule does not stop the others", async () => {
      const good = await insertRule({ service: "good", forMinutes: 0 });
      await insertRule({ service: "bad", forMinutes: 0 });
      await seedMinute(db.pool, {
        minuteMs: base,
        service: "good",
        count: 100,
        errors: 90,
      });
      const messages: string[] = [];
      // Injected fault: a constraint that makes writing the second rule's state fail.
      await db.pool.query(
        "ALTER TABLE alert_state ADD CONSTRAINT test_no_bad CHECK (rule_id <> $1)".replace(
          "$1",
          String(good + 1),
        ),
      );
      try {
        const r = await run(
          evaluator({ now: base }, { onError: (m) => messages.push(m) }),
        );
        expect(r.evaluated).toBe(1);
        expect(r.deliveries).toHaveLength(1);
        expect(await state(good)).toMatchObject({ state: "firing" });
        expect(
          messages.some((m) =>
            m.startsWith(`alert rule ${good + 1}: evaluation failed`),
          ),
        ).toBe(true);
      } finally {
        await db.pool.query(
          "ALTER TABLE alert_state DROP CONSTRAINT test_no_bad",
        );
      }
    });

    it("runs never overlap", async () => {
      const e = evaluator({ now: base });
      const [a, b] = await Promise.all([e.runOnce(), e.runOnce()]);
      expect([a.skipped, b.skipped]).toContain("busy");
    });
  });
});
