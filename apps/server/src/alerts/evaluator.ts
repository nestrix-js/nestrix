/**
 * Evaluates every enabled alert rule once a minute and sends the notifications its state
 * machine (`state.ts`) calls for.
 *
 * - The timer is unref'd and a run never overlaps the previous one (a tick during a run is skipped).
 * - A run first takes the session advisory lock `ALERTS_LOCK` with `pg_try_advisory_lock` on a
 *   dedicated connection: when another server instance holds it, this instance skips the run.
 *   Each rule is then evaluated in its own transaction that locks its state row, so even two runs
 *   back to back (one per instance, a few seconds apart) read the state the other wrote and a
 *   transition, and its notification, happens once.
 * - The notification row (`alert_events`, delivery `pending`) is written in the same transaction
 *   as the state change; the webhook is sent after the commit, outside the lock, and the row is
 *   then updated with the outcome. A crash between the two leaves the row `pending` and the
 *   notification unsent (at most once, never twice).
 * - Every failure is caught and logged per rule; nothing here can throw out of the timer.
 * - Rows of `alert_events` older than the retention are deleted at most once an hour.
 */
import type { Pool, PoolClient } from "pg";
import { ADVISORY_CLASS, ALERTS_LOCK } from "../storage/locks.js";
import { METRICS } from "./metrics.js";
import { type StoredState, transition } from "./state.js";
import { type AlertRuleRow, buildPayload, type EventKind } from "./store.js";
import type { DeliveryResult, WebhookSender } from "./webhook.js";

export interface AlertEvaluatorOptions {
  retentionDays: number;
  publicUrl?: string | undefined;
  /** Default 60 000. */
  intervalMs?: number;
  /** First run after start. Default 10 000. */
  initialDelayMs?: number;
  /** Clock (Unix ms); replaceable in tests. */
  now?: () => number;
  /** Where failures are reported (never with a secret or a URL path). */
  onError?: (message: string) => void;
}

export interface EvaluationRun {
  /** `locked`: another instance holds the lock; `busy`: this instance is still running. */
  skipped?: "locked" | "busy";
  evaluated: number;
  /** One per notification sent by this run, resolved when its delivery finished. */
  deliveries: Promise<DeliveryResult>[];
}

interface PendingNotification {
  eventId: number;
  ruleId: number;
  url: string;
  secret: string;
  body: string;
}

const PRUNE_EVERY_MS = 3_600_000;

export class AlertEvaluator {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly now: () => number;
  private readonly onError: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<EvaluationRun> | undefined;
  private lastPruneMs = 0;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly sender: WebhookSender,
    private readonly options: AlertEvaluatorOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.initialDelayMs = options.initialDelayMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const tick = () => {
      this.runOnce().catch(() => undefined);
    };
    const first = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, this.intervalMs);
      this.timer.unref();
    }, this.initialDelayMs);
    first.unref();
    this.timer = first;
  }

  /** Stops the timer and waits for a run in progress (not for its webhooks: see the sender's close). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running?.catch(() => undefined);
  }

  /** One evaluation of every enabled rule. Never rejects. */
  runOnce(): Promise<EvaluationRun> {
    if (this.running !== undefined) {
      return Promise.resolve({ skipped: "busy", evaluated: 0, deliveries: [] });
    }
    const run = this.evaluateAll()
      .catch((error) => {
        this.report("alert evaluation failed", error);
        return { evaluated: 0, deliveries: [] } as EvaluationRun;
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = run;
    return run;
  }

  private report(context: string, error: unknown): void {
    try {
      this.onError(`${context}: ${(error as Error)?.message ?? String(error)}`);
    } catch {
      // A failing logger must not break the run.
    }
  }

  private async evaluateAll(): Promise<EvaluationRun> {
    const client = await this.pool.connect();
    let locked = false;
    let broken: Error | undefined;
    const notifications: PendingNotification[] = [];
    let evaluated = 0;
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [ADVISORY_CLASS, ALERTS_LOCK],
      );
      locked = rows[0]?.locked === true;
      if (!locked) return { skipped: "locked", evaluated: 0, deliveries: [] };

      const ids = await client.query<{ id: string }>(
        "SELECT id FROM alert_rules WHERE enabled ORDER BY id",
      );
      const nowMs = this.now();
      for (const { id } of ids.rows) {
        try {
          const n = await this.evaluateRule(client, Number(id), nowMs);
          evaluated++;
          if (n !== undefined) notifications.push(n);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          this.report(`alert rule ${id}: evaluation failed`, error);
        }
      }
      if (nowMs - this.lastPruneMs >= PRUNE_EVERY_MS) {
        try {
          await client.query("DELETE FROM alert_events WHERE created_at < $1", [
            new Date(nowMs - this.options.retentionDays * 86_400_000),
          ]);
          this.lastPruneMs = nowMs;
        } catch (error) {
          this.report("alert history retention failed", error);
        }
      }
    } catch (error) {
      broken = error as Error;
      throw error;
    } finally {
      try {
        if (locked && broken === undefined) {
          await client.query("SELECT pg_advisory_unlock($1, $2)", [
            ADVISORY_CLASS,
            ALERTS_LOCK,
          ]);
        }
        // A connection whose state is unknown is discarded (which also releases the lock).
        client.release(broken);
      } catch (error) {
        client.release(error as Error);
      }
    }
    return {
      evaluated,
      deliveries: notifications.map((n) => this.dispatch(n)),
    };
  }

  /** One rule in one transaction. Returns the notification to send after the commit, if any. */
  private async evaluateRule(
    client: PoolClient,
    id: number,
    nowMs: number,
  ): Promise<PendingNotification | undefined> {
    await client.query("BEGIN");
    // FOR SHARE: an API update or delete of this rule waits for the evaluation to commit.
    const ruleRes = await client.query<AlertRuleRow>(
      "SELECT * FROM alert_rules WHERE id = $1 AND enabled FOR SHARE",
      [id],
    );
    const rule = ruleRes.rows[0];
    if (rule === undefined) {
      await client.query("COMMIT");
      return undefined;
    }
    const stateRes = await client.query<{
      state: StoredState["state"];
      since: Date;
    }>("SELECT state, since FROM alert_state WHERE rule_id = $1 FOR UPDATE", [
      id,
    ]);
    const stored = stateRes.rows[0];
    const current: StoredState | undefined =
      stored === undefined
        ? undefined
        : { state: stored.state, sinceMs: stored.since.getTime() };

    const metric = METRICS[rule.metric];
    const value =
      metric === undefined
        ? null
        : await metric(
            client,
            {
              serviceName: rule.service_name,
              route: rule.route,
              windowMinutes: rule.window_minutes,
              minRequests: rule.min_requests,
            },
            nowMs,
          );
    const t = transition(
      current,
      value,
      rule.threshold,
      rule.for_minutes,
      nowMs,
    );
    await client.query(
      `INSERT INTO alert_state (rule_id, state, since, last_value, last_evaluated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (rule_id) DO UPDATE
         SET state = EXCLUDED.state, since = EXCLUDED.since,
             last_value = EXCLUDED.last_value, last_evaluated_at = EXCLUDED.last_evaluated_at`,
      [id, t.next.state, new Date(t.next.sinceMs), value, new Date(nowMs)],
    );
    let notification: PendingNotification | undefined;
    if (t.notify !== undefined) {
      const kind: EventKind = t.notify;
      const ev = await client.query<{ id: string }>(
        `INSERT INTO alert_events (rule_id, created_at, kind, value, threshold)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [id, new Date(nowMs), kind, value, rule.threshold],
      );
      notification = {
        eventId: Number(ev.rows[0]?.id),
        ruleId: id,
        url: rule.webhook_url,
        secret: rule.secret,
        body: JSON.stringify(
          buildPayload(
            rule,
            kind,
            value,
            t.startedAtMs,
            nowMs,
            this.options.publicUrl,
          ),
        ),
      };
    }
    await client.query("COMMIT");
    return notification;
  }

  /** Never rejects: the timer does not wait for deliveries, so a rejection would go unhandled. */
  private async dispatch(n: PendingNotification): Promise<DeliveryResult> {
    let result: DeliveryResult;
    try {
      result = await this.sender.send(
        String(n.ruleId),
        n.url,
        n.secret,
        n.body,
      );
    } catch {
      result = {
        delivery: "failed",
        attempts: 0,
        status: null,
        error: "internal",
      };
    }
    await recordDelivery(this.pool, n.eventId, n.ruleId, result).catch(
      (error) =>
        this.report(
          `alert rule ${n.ruleId}: recording the delivery failed`,
          error,
        ),
    );
    if (result.delivery !== "sent") {
      this.report(
        `alert rule ${n.ruleId}: webhook ${result.delivery} after ${result.attempts} attempt(s)`,
        new Error(result.error ?? "unknown"),
      );
    }
    return result;
  }
}

/** Writes a delivery's outcome to its event row (and `last_notified_at` when it was sent). */
export async function recordDelivery(
  pool: Pool,
  eventId: number,
  ruleId: number,
  result: DeliveryResult,
): Promise<void> {
  await pool.query(
    `UPDATE alert_events SET delivery = $2, attempts = $3, response_status = $4, error = $5
      WHERE id = $1`,
    [eventId, result.delivery, result.attempts, result.status, result.error],
  );
  if (result.delivery === "sent") {
    await pool.query(
      "UPDATE alert_state SET last_notified_at = now() WHERE rule_id = $1",
      [ruleId],
    );
  }
}
