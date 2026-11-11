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
  "slo_id",
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

/** An update would leave the threshold unsuited to the metric (the table's CHECK refused it). */
export class RuleInconsistentError extends Error {
  constructor() {
    super("threshold does not suit the metric");
    this.name = "RuleInconsistentError";
  }
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

  /**
   * A `slo_burn_rate` rule takes its service and route from its SLO. Returns the fields to store,
   * or a message when the SLO does not exist.
   */
  async withSloTarget(
    fields: RuleFields,
  ): Promise<
    { ok: true; fields: RuleFields } | { ok: false; message: string }
  > {
    if (fields.slo_id === undefined || fields.slo_id === null) {
      return { ok: true, fields };
    }
    const { rows } = await this.pool.query<{
      service_name: string;
      route: string | null;
    }>("SELECT service_name, route FROM slos WHERE id = $1", [fields.slo_id]);
    const slo = rows[0];
    if (slo === undefined) return { ok: false, message: "No such SLO." };
    return {
      ok: true,
      fields: { ...fields, service_name: slo.service_name, route: slo.route },
    };
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
        fields.slo_id !== undefined ||
        fields.metric !== undefined
      ) {
        await client.query("DELETE FROM alert_state WHERE rule_id = $1", [id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Two concurrent PATCHes can each pass the API's check against the old row; the table's
      // CHECK (0004_alert_checks.sql) is what refuses the combination.
      if ((error as { code?: string }).code === "23514") {
        throw new RuleInconsistentError();
      }
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
      buildPayload(
        rule,
        eventId,
        "test",
        null,
        nowMs,
        nowMs,
        this.options.publicUrl,
      ),
    );
    const result = await this.sender.send(
      String(id),
      rule.webhook_url,
      rule.secret,
      body,
      { maxAttempts: 1, eventId },
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
