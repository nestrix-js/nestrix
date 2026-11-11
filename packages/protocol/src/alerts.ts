/**
 * Alerting API of the standalone server (`/api/v1/alerts`, docs/backlog/phase-7.md P7-03).
 * The embedded dashboard has no alerts, so `@nestrix/nestjs` does not mirror these types.
 * Types only: this file adds no runtime export.
 */

/** `error_rate`: errors / requests as a fraction (0.05 is 5%). `p95_ms`: latency in ms. */
export type AlertMetric = "error_rate" | "p95_ms";

/** `pending`: breaching, but not yet for `forMinutes`. */
export type AlertStateName = "ok" | "pending" | "firing";

export interface AlertRule {
  /** Decimal string of the rule's numeric id. */
  id: string;
  name: string;
  service: string;
  /** `null`: every route of the service. */
  route: string | null;
  metric: AlertMetric;
  comparator: ">";
  threshold: number;
  windowMinutes: number;
  forMinutes: number;
  minRequests: number;
  webhookUrl: string;
  enabled: boolean;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  state: {
    state: AlertStateName;
    /** When the rule entered `state`; `null` before its first evaluation. */
    sinceUnixMs: number | null;
    lastValue: number | null;
    lastEvaluatedAtUnixMs: number | null;
    lastNotifiedAtUnixMs: number | null;
  };
}

/** `POST /api/v1/alerts`. Unknown fields are refused (400). */
export interface AlertRuleCreate {
  name: string;
  service: string;
  route?: string | null;
  metric: AlertMetric;
  comparator?: ">";
  threshold: number;
  windowMinutes: number;
  /** Default 2. */
  forMinutes?: number;
  /** Default 10. */
  minRequests?: number;
  webhookUrl: string;
  /** Default true. */
  enabled?: boolean;
}

/** `PATCH /api/v1/alerts/:id`: any subset of the create fields. */
export type AlertRuleUpdate = Partial<AlertRuleCreate>;

export interface AlertRuleListResponse {
  rules: AlertRule[];
}

/** `POST /api/v1/alerts` answers 201 with the rule and its signing secret, shown only here. */
export interface AlertRuleCreateResponse {
  rule: AlertRule;
  secret: string;
}

export type AlertEventKind = "firing" | "resolved" | "test";
export type AlertDelivery = "pending" | "sent" | "failed" | "refused";

export interface AlertEvent {
  id: string;
  ruleId: string;
  atUnixMs: number;
  kind: AlertEventKind;
  value: number | null;
  threshold: number;
  delivery: AlertDelivery;
  attempts: number;
  responseStatus: number | null;
  /** A short category such as `timeout` or `refused_address`; never a response body. */
  error: string | null;
}

/** `GET /api/v1/alerts/events?rule=&limit=`, newest first. */
export interface AlertEventListResponse {
  events: AlertEvent[];
}

/** `POST /api/v1/alerts/:id/test`. */
export interface AlertTestResponse {
  event: AlertEvent;
}

/**
 * The JSON body of a webhook `POST`. Headers: `x-nestrix-timestamp` (Unix seconds) and
 * `x-nestrix-signature: sha256=<hex>`, the HMAC-SHA256 with the rule's secret of
 * `<timestamp>.<raw body>`.
 */
export interface AlertWebhookPayload {
  rule: { id: string; name: string; metric: AlertMetric; comparator: ">" };
  state: "firing" | "resolved" | "test";
  value: number | null;
  threshold: number;
  window: { minutes: number };
  service: string;
  route: string | null;
  /** When the condition started (firing), or when the alert began (resolved). ISO 8601. */
  startedAt: string;
  /** ISO 8601 time of this notification. */
  sentAt: string;
  /** The dashboard (`NESTRIX_PUBLIC_URL`), or `null` when it is not configured. */
  url: string | null;
}
