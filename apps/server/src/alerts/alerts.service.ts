import { Inject, Injectable } from "@nestjs/common";
import type {
  AlertEvent,
  AlertRule,
  AlertRuleCreateResponse,
} from "@nestrix/protocol";
import type { Pool } from "pg";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { recordDelivery } from "./evaluator.js";
import {
  type AlertEventRow,
  type AlertRuleRow,
  type AlertStateRow,
  buildPayload,
  generateSecret,
  type RuleFields,
  toApiEvent,
  toApiRule,
} from "./store.js";
import { ALERTS_OPTIONS, type ResolvedAlertsOptions } from "./tokens.js";
import { WebhookSender } from "./webhook.js";

const COLUMNS: (keyof RuleFields)[] = [
  "name",
  "service_name",
  "route",
  "metric",
  "threshold",
  "window_minutes",
  "for_minutes",
  "min_requests",
  "webhook_url",
  "enabled",
];

type RuleWithState = AlertRuleRow & {
  state: AlertStateRow["state"] | null;
  since: Date | null;
  last_value: number | null;
  last_evaluated_at: Date | null;
  last_notified_at: Date | null;
};

const SELECT_WITH_STATE = `SELECT r.*, s.state, s.since, s.last_value, s.last_evaluated_at, s.last_notified_at
  FROM alert_rules r LEFT JOIN alert_state s ON s.rule_id = r.id`;

function withState(row: RuleWithState): AlertRule {
  return toApiRule(
    row,
    row.state === null
      ? undefined
      : {
          state: row.state,
          since: row.since ?? undefined,
          last_value: row.last_value,
          last_evaluated_at: row.last_evaluated_at ?? undefined,
          last_notified_at: row.last_notified_at,
        },
  );
}

/** Rules and history in Postgres, for the API. */
@Injectable()
export class AlertsService {
  constructor(
    @Inject(STORAGE_POOL) private readonly pool: Pool,
    @Inject(WebhookSender) private readonly sender: WebhookSender,
    @Inject(ALERTS_OPTIONS) private readonly options: ResolvedAlertsOptions,
  ) {}

  async list(): Promise<AlertRule[]> {
    const { rows } = await this.pool.query<RuleWithState>(
      `${SELECT_WITH_STATE} ORDER BY r.id`,
    );
    return rows.map(withState);
  }

  async get(id: number): Promise<AlertRule | undefined> {
    const { rows } = await this.pool.query<RuleWithState>(
      `${SELECT_WITH_STATE} WHERE r.id = $1`,
      [id],
    );
    return rows[0] === undefined ? undefined : withState(rows[0]);
  }

  async row(id: number): Promise<AlertRuleRow | undefined> {
    const { rows } = await this.pool.query<AlertRuleRow>(
      "SELECT * FROM alert_rules WHERE id = $1",
      [id],
    );
    return rows[0];
  }

  async create(fields: RuleFields): Promise<AlertRuleCreateResponse> {
    const secret = generateSecret();
    const names = COLUMNS.filter((c) => fields[c] !== undefined);
    const values = names.map((c) => fields[c]);
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO alert_rules (${[...names, "secret"].join(", ")})
       VALUES (${[...names, "secret"].map((_, i) => `$${i + 1}`).join(", ")})
       RETURNING id`,
      [...values, secret],
    );
    const rule = await this.get(Number(rows[0]?.id));
    if (rule === undefined) throw new Error("created rule not found");
    return { rule, secret };
  }

  /**
   * Updates the given fields. Disabling a rule, or changing what it measures (service, route or
   * metric), resets its state to `ok` without a notification.
   */
  async update(id: number, fields: RuleFields): Promise<AlertRule | undefined> {
    const names = COLUMNS.filter((c) => fields[c] !== undefined);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE alert_rules SET ${names.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now()
          WHERE id = $1`,
        [id, ...names.map((c) => fields[c])],
      );
      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return undefined;
      }
      if (
        fields.enabled === false ||
        fields.service_name !== undefined ||
        fields.route !== undefined ||
        fields.metric !== undefined
      ) {
        await client.query("DELETE FROM alert_state WHERE rule_id = $1", [id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.get(id);
  }

  async remove(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM alert_rules WHERE id = $1",
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async events(
    ruleId: number | undefined,
    limit: number,
  ): Promise<AlertEvent[]> {
    const { rows } = await this.pool.query<AlertEventRow>(
      ruleId === undefined
        ? "SELECT * FROM alert_events ORDER BY id DESC LIMIT $1"
        : "SELECT * FROM alert_events WHERE rule_id = $2 ORDER BY id DESC LIMIT $1",
      ruleId === undefined ? [limit] : [limit, ruleId],
    );
    return rows.map(toApiEvent);
  }

  /**
   * Sends a `test` notification to the rule's webhook now (one attempt, after any delivery in
   * flight for the rule), records it in the history and returns it.
   */
  async testSend(id: number): Promise<AlertEvent | undefined> {
    const rule = await this.row(id);
    if (rule === undefined) return undefined;
    const nowMs = Date.now();
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO alert_events (rule_id, kind, value, threshold)
       VALUES ($1, 'test', NULL, $2) RETURNING id`,
      [id, rule.threshold],
    );
    const eventId = Number(rows[0]?.id);
    const body = JSON.stringify(
      buildPayload(rule, "test", null, nowMs, nowMs, this.options.publicUrl),
    );
    const result = await this.sender.send(
      String(id),
      rule.webhook_url,
      rule.secret,
      body,
      { maxAttempts: 1 },
    );
    await recordDelivery(this.pool, eventId, id, result);
    const ev = await this.pool.query<AlertEventRow>(
      "SELECT * FROM alert_events WHERE id = $1",
      [eventId],
    );
    const row = ev.rows[0];
    return row === undefined ? undefined : toApiEvent(row);
  }
}
