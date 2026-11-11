/**
 * Rows of the alert tables, their API shapes (`@nestrix/protocol`, types only), the webhook
 * payload, and strict validation of API input.
 */
import { randomBytes } from "node:crypto";
import type {
  AlertEvent,
  AlertRule,
  AlertRuleCreate,
  AlertWebhookPayload,
} from "@nestrix/protocol";
import { webhookUrlProblem } from "./webhook.js";

export type EventKind = "firing" | "resolved" | "test";

/** `SELECT * FROM alert_rules` as pg returns it (bigint as string). */
export interface AlertRuleRow {
  id: string;
  name: string;
  service_name: string;
  route: string | null;
  metric: "error_rate" | "p95_ms";
  comparator: ">";
  threshold: number;
  window_minutes: number;
  for_minutes: number;
  min_requests: number;
  webhook_url: string;
  secret: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AlertStateRow {
  state: "ok" | "pending" | "firing";
  since: Date;
  last_value: number | null;
  last_evaluated_at: Date;
  last_notified_at: Date | null;
}

export interface AlertEventRow {
  id: string;
  rule_id: string;
  created_at: Date;
  kind: EventKind;
  value: number | null;
  threshold: number;
  delivery: AlertEvent["delivery"];
  attempts: number;
  response_status: number | null;
  error: string | null;
}

/** A new rule's signing secret: 32 random bytes, base64url, with a recognisable prefix. */
export function generateSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function toApiRule(
  rule: AlertRuleRow,
  state: Partial<AlertStateRow> | undefined,
): AlertRule {
  const ms = (d: Date | null | undefined) =>
    d === null || d === undefined ? null : d.getTime();
  return {
    id: String(rule.id),
    name: rule.name,
    service: rule.service_name,
    route: rule.route,
    metric: rule.metric,
    comparator: rule.comparator,
    threshold: rule.threshold,
    windowMinutes: rule.window_minutes,
    forMinutes: rule.for_minutes,
    minRequests: rule.min_requests,
    webhookUrl: rule.webhook_url,
    enabled: rule.enabled,
    createdAtUnixMs: rule.created_at.getTime(),
    updatedAtUnixMs: rule.updated_at.getTime(),
    state: {
      state: state?.state ?? "ok",
      sinceUnixMs: ms(state?.since),
      lastValue: state?.last_value ?? null,
      lastEvaluatedAtUnixMs: ms(state?.last_evaluated_at),
      lastNotifiedAtUnixMs: ms(state?.last_notified_at),
    },
  };
}

export function toApiEvent(row: AlertEventRow): AlertEvent {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    atUnixMs: row.created_at.getTime(),
    kind: row.kind,
    value: row.value,
    threshold: row.threshold,
    delivery: row.delivery,
    attempts: row.attempts,
    responseStatus: row.response_status,
    error: row.error,
  };
}

export function buildPayload(
  rule: Pick<
    AlertRuleRow,
    | "id"
    | "name"
    | "metric"
    | "comparator"
    | "threshold"
    | "window_minutes"
    | "service_name"
    | "route"
  >,
  eventId: number,
  kind: EventKind,
  value: number | null,
  startedAtMs: number,
  nowMs: number,
  publicUrl: string | undefined,
): AlertWebhookPayload {
  return {
    eventId: String(eventId),
    rule: {
      id: String(rule.id),
      name: rule.name,
      metric: rule.metric,
      comparator: rule.comparator,
    },
    state: kind,
    value,
    threshold: rule.threshold,
    window: { minutes: rule.window_minutes },
    service: rule.service_name,
    route: rule.route,
    startedAt: new Date(startedAtMs).toISOString(),
    sentAt: new Date(nowMs).toISOString(),
    url: publicUrl === undefined ? null : `${publicUrl}/`,
  };
}

/** Validated rule fields, in column names. */
export interface RuleFields {
  name?: string;
  service_name?: string;
  route?: string | null;
  metric?: "error_rate" | "p95_ms";
  threshold?: number;
  window_minutes?: number;
  for_minutes?: number;
  min_requests?: number;
  webhook_url?: string;
  enabled?: boolean;
}

export type Validation =
  | { ok: true; fields: RuleFields }
  | { ok: false; message: string };

const KEYS = new Set<keyof AlertRuleCreate>([
  "name",
  "service",
  "route",
  "metric",
  "comparator",
  "threshold",
  "windowMinutes",
  "forMinutes",
  "minRequests",
  "webhookUrl",
  "enabled",
]);
const REQUIRED: (keyof AlertRuleCreate)[] = [
  "name",
  "service",
  "metric",
  "threshold",
  "windowMinutes",
  "webhookUrl",
];

/** True for text without control characters (C0, DEL, C1) and lone surrogates. */
function cleanText(s: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  return !/[\u0000-\u001f\u007f-\u009f]/.test(s) && s.isWellFormed();
}

function text(
  value: unknown,
  field: string,
  max: number,
): string | { error: string } {
  if (typeof value !== "string") return { error: `${field} must be a string.` };
  const v = value.trim();
  if (v.length === 0 || v.length > max) {
    return { error: `${field} must have 1 to ${max} characters.` };
  }
  if (!cleanText(v)) return { error: `${field} contains control characters.` };
  return v;
}

function int(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | { error: string } {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return { error: `${field} must be a whole number from ${min} to ${max}.` };
  }
  return value;
}

/**
 * Checks a create (`partial` false) or update (`partial` true) body. Unknown fields, wrong types
 * and out-of-range values are refused. For an update, `metric` and `threshold` are checked
 * together against `existing` when only one of them is given.
 */
export function validateRuleInput(
  body: unknown,
  partial: boolean,
  allowedHosts: readonly string[],
  existing?: Pick<AlertRuleRow, "metric" | "threshold">,
): Validation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "The body must be a JSON object." };
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key as keyof AlertRuleCreate)) {
      return { ok: false, message: `Unknown field: ${key.slice(0, 64)}.` };
    }
  }
  if (!partial) {
    for (const key of REQUIRED) {
      if (input[key] === undefined) {
        return { ok: false, message: `${key} is required.` };
      }
    }
  } else if (Object.keys(input).length === 0) {
    return { ok: false, message: "Nothing to update." };
  }
  const fields: RuleFields = {};
  const fail = (message: string): Validation => ({ ok: false, message });
  const has = (k: string) => Object.hasOwn(input, k) && input[k] !== undefined;

  if (has("name")) {
    const v = text(input.name, "name", 200);
    if (typeof v !== "string") return fail(v.error);
    fields.name = v;
  }
  if (has("service")) {
    const v = text(input.service, "service", 256);
    if (typeof v !== "string") return fail(v.error);
    fields.service_name = v;
  }
  if (has("route") || Object.hasOwn(input, "route")) {
    if (input.route === null || input.route === undefined) {
      fields.route = null;
    } else {
      const v = text(input.route, "route", 512);
      if (typeof v !== "string") return fail(v.error);
      fields.route = v;
    }
  }
  if (has("metric")) {
    if (input.metric !== "error_rate" && input.metric !== "p95_ms") {
      return fail('metric must be "error_rate" or "p95_ms".');
    }
    fields.metric = input.metric;
  }
  if (has("comparator") && input.comparator !== ">") {
    return fail('comparator must be ">".');
  }
  if (has("threshold")) {
    if (
      typeof input.threshold !== "number" ||
      !Number.isFinite(input.threshold)
    ) {
      return fail("threshold must be a number.");
    }
    fields.threshold = input.threshold;
  }
  if (has("windowMinutes")) {
    const v = int(input.windowMinutes, "windowMinutes", 5, 60);
    if (typeof v !== "number") return fail(v.error);
    fields.window_minutes = v;
  }
  if (has("forMinutes")) {
    const v = int(input.forMinutes, "forMinutes", 0, 60);
    if (typeof v !== "number") return fail(v.error);
    fields.for_minutes = v;
  }
  if (has("minRequests")) {
    const v = int(input.minRequests, "minRequests", 1, 1_000_000);
    if (typeof v !== "number") return fail(v.error);
    fields.min_requests = v;
  }
  if (has("webhookUrl")) {
    if (
      typeof input.webhookUrl !== "string" ||
      input.webhookUrl.length > 2048
    ) {
      return fail("webhookUrl must be a string of at most 2048 characters.");
    }
    const problem = webhookUrlProblem(input.webhookUrl, allowedHosts);
    if (problem !== undefined) return fail(problem);
    fields.webhook_url = new URL(input.webhookUrl).href;
  }
  if (has("enabled")) {
    if (typeof input.enabled !== "boolean")
      return fail("enabled must be true or false.");
    fields.enabled = input.enabled;
  }

  const metric = fields.metric ?? existing?.metric;
  const threshold = fields.threshold ?? existing?.threshold;
  if (metric !== undefined && threshold !== undefined) {
    if (metric === "error_rate" && !(threshold >= 0 && threshold < 1)) {
      return fail(
        "threshold of error_rate is a fraction from 0 (inclusive) to 1 (exclusive), e.g. 0.05 for 5%.",
      );
    }
    if (metric === "p95_ms" && !(threshold > 0 && threshold <= 3_600_000)) {
      return fail(
        "threshold of p95_ms is in milliseconds, above 0 and at most 3600000.",
      );
    }
  }
  return { ok: true, fields };
}
