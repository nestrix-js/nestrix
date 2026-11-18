import type {
  AlertEvent,
  AlertMetric,
  AlertRule,
  AlertRuleCreate,
  AlertRuleUpdate,
} from "@nestrix-js/protocol";

/** The metrics this page has a form for. A rule of any other kind is shown read-only. */
export const KNOWN_METRICS: readonly AlertMetric[] = [
  "error_rate",
  "p95_ms",
  "slo_burn_rate",
];

export const METRIC_LABEL: Record<AlertMetric, string> = {
  error_rate: "Error rate",
  p95_ms: "p95 latency",
  slo_burn_rate: "SLO burn rate",
};

/** True for a metric the form can edit; false for a kind a newer server added. */
export function isKnownMetric(metric: string): metric is AlertMetric {
  return (KNOWN_METRICS as readonly string[]).includes(metric);
}

export function metricLabel(metric: string): string {
  return isKnownMetric(metric) ? METRIC_LABEL[metric] : metric;
}

function trim(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** A metric value or threshold in its unit: `5%`, `300 ms`, `14.4x`; "-" without one. */
export function formatMetricValue(
  metric: string,
  value: number | null,
): string {
  if (value === null || !Number.isFinite(value)) return "-";
  switch (metric) {
    case "error_rate":
      return `${trim((value * 100).toFixed(3))}%`;
    case "p95_ms":
      return `${trim(value.toFixed(1))} ms`;
    case "slo_burn_rate":
      return `${trim(value.toFixed(2))}x`;
    default:
      return trim(value.toFixed(3));
  }
}

export type RuleStateKey =
  | "disabled"
  | "firing"
  | "pending"
  | "no-data"
  | "resolved"
  | "ok"
  | "not-evaluated";

export interface RuleStateView {
  key: RuleStateKey;
  label: string;
  tone: "worse" | "warn" | "better" | "neutral";
}

/**
 * The state shown for a rule. The server stores `ok`, `pending` and `firing`; the page adds what
 * it can tell from the rest of the state: a disabled rule, "no data" (the last evaluation had
 * fewer requests than `minRequests`, so the state did not change), "resolved" (back to `ok` after
 * a notification) and "not evaluated yet".
 */
export function ruleState(
  rule: Pick<AlertRule, "enabled" | "state">,
): RuleStateView {
  if (!rule.enabled)
    return { key: "disabled", label: "Disabled", tone: "neutral" };
  const s = rule.state;
  const noData = s.lastEvaluatedAtUnixMs !== null && s.lastValue === null;
  if (s.state === "firing") {
    return {
      key: "firing",
      label: noData ? "Firing (no data now)" : "Firing",
      tone: "worse",
    };
  }
  if (s.state === "pending") {
    return {
      key: "pending",
      label: noData ? "Pending (no data now)" : "Pending",
      tone: "warn",
    };
  }
  if (s.lastEvaluatedAtUnixMs === null) {
    return {
      key: "not-evaluated",
      label: "Not evaluated yet",
      tone: "neutral",
    };
  }
  if (noData) return { key: "no-data", label: "No data", tone: "neutral" };
  if (s.lastNotifiedAtUnixMs !== null) {
    return { key: "resolved", label: "Resolved", tone: "better" };
  }
  return { key: "ok", label: "OK", tone: "better" };
}

export interface AlertsSummary {
  rules: number;
  firing: number;
  pending: number;
  noData: number;
}

export function summarizeRules(rules: readonly AlertRule[]): AlertsSummary {
  const out: AlertsSummary = {
    rules: rules.length,
    firing: 0,
    pending: 0,
    noData: 0,
  };
  for (const rule of rules) {
    const key = ruleState(rule).key;
    if (key === "firing") out.firing += 1;
    else if (key === "pending") out.pending += 1;
    else if (key === "no-data") out.noData += 1;
  }
  return out;
}

/**
 * The webhook as `host/path-hidden`: the path and query of a webhook URL often are the secret
 * (a Slack incoming webhook), so the list shows the origin only. The edit form has the full URL.
 */
export function webhookOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid URL)";
  }
}

/** One line for a delivery's outcome, with the HTTP status and the error category. */
export function describeDelivery(
  event: Pick<AlertEvent, "delivery" | "attempts" | "responseStatus" | "error">,
): string {
  const parts: string[] = [event.delivery];
  if (event.responseStatus !== null) parts.push(`HTTP ${event.responseStatus}`);
  if (event.error !== null) parts.push(event.error.replaceAll("_", " "));
  if (event.attempts > 1) parts.push(`${event.attempts} attempts`);
  return parts.join(" · ");
}

export function deliveryTone(
  delivery: string,
): "better" | "worse" | "warn" | "neutral" {
  if (delivery === "sent") return "better";
  if (delivery === "failed" || delivery === "refused") return "worse";
  if (delivery === "pending") return "warn";
  return "neutral";
}

/** What the form edits, as text the user types. */
export interface AlertForm {
  name: string;
  metric: AlertMetric;
  service: string;
  route: string;
  sloId: string;
  /** error_rate in percent, p95_ms in ms, slo_burn_rate as a multiple. */
  threshold: string;
  windowMinutes: string;
  forMinutes: string;
  minRequests: string;
  webhookUrl: string;
  enabled: boolean;
}

export function emptyForm(service = ""): AlertForm {
  return {
    name: "",
    metric: "error_rate",
    service,
    route: "",
    sloId: "",
    threshold: "5",
    windowMinutes: "5",
    forMinutes: "2",
    minRequests: "10",
    webhookUrl: "",
    enabled: true,
  };
}

function thresholdText(metric: AlertMetric, threshold: number): string {
  // 0.07 * 100 is 7.000000000000001: round to the digits a person types.
  return metric === "error_rate"
    ? trim((threshold * 100).toFixed(4))
    : trim(String(threshold));
}

/** The form for a rule of a known metric. */
export function formFromRule(
  rule: AlertRule & { metric: AlertMetric },
): AlertForm {
  return {
    name: rule.name,
    metric: rule.metric,
    service: rule.service,
    route: rule.route ?? "",
    sloId: rule.sloId ?? "",
    threshold: thresholdText(rule.metric, rule.threshold),
    windowMinutes: String(rule.windowMinutes),
    forMinutes: String(rule.forMinutes),
    minRequests: String(rule.minRequests),
    webhookUrl: rule.webhookUrl,
    enabled: rule.enabled,
  };
}

// The server's own checks (apps/server/src/alerts/store.ts), repeated so a mistake is shown
// before the request. The server stays the authority: its message is shown when it refuses.
// Control characters in a name: the server refuses them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function checkedText(
  value: string,
  field: string,
  max: number,
): { ok: true; value: string } | { ok: false; message: string } {
  const v = value.trim();
  if (v.length === 0 || v.length > max) {
    return { ok: false, message: `${field} must have 1 to ${max} characters.` };
  }
  if (CONTROL.test(v)) {
    return { ok: false, message: `${field} contains control characters.` };
  }
  return { ok: true, value: v };
}

function checkedInt(
  value: string,
  field: string,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; message: string } {
  const v = value.trim();
  const n = Number(v);
  if (!/^[0-9]+$/.test(v) || !Number.isSafeInteger(n) || n < min || n > max) {
    return {
      ok: false,
      message: `${field} must be a whole number from ${min} to ${max}.`,
    };
  }
  return { ok: true, value: n };
}

export type RequestResult<T> =
  | { ok: true; body: T }
  | { ok: false; message: string };

/**
 * The request body for a form, or the first problem. `slo_burn_rate` rules send `sloId` and no
 * service or route (the server takes them from the SLO and refuses them otherwise); the other
 * metrics send the service and route and no `sloId`.
 */
export function toRequest(
  form: AlertForm,
): RequestResult<AlertRuleCreate & AlertRuleUpdate> {
  const fail = (message: string) => ({ ok: false as const, message });
  const name = checkedText(form.name, "Name", 200);
  if (!name.ok) return fail(name.message);

  const raw = form.threshold.trim();
  const entered = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(entered)) return fail("Threshold must be a number.");
  let threshold = entered;
  if (form.metric === "error_rate") {
    if (!(entered >= 0 && entered < 100)) {
      return fail(
        "Threshold of an error rate is a percentage from 0 up to, not including, 100, e.g. 5.",
      );
    }
    threshold = Number((entered / 100).toPrecision(12));
  } else if (form.metric === "p95_ms") {
    if (!(entered > 0 && entered <= 3_600_000)) {
      return fail(
        "Threshold of a p95 is in milliseconds, above 0 and at most 3600000.",
      );
    }
  } else if (!(entered > 0 && entered <= 1000)) {
    return fail(
      "Threshold of a burn rate is a multiple above 0 and at most 1000, e.g. 14.4.",
    );
  }

  const windowMinutes = checkedInt(form.windowMinutes, "Window", 5, 60);
  if (!windowMinutes.ok) return fail(windowMinutes.message);
  const forMinutes = checkedInt(form.forMinutes, "Pending duration", 0, 60);
  if (!forMinutes.ok) return fail(forMinutes.message);
  const minRequests = checkedInt(
    form.minRequests,
    "Minimum requests",
    1,
    1_000_000,
  );
  if (!minRequests.ok) return fail(minRequests.message);

  const url = form.webhookUrl.trim();
  if (url.length === 0 || url.length > 2048) {
    return fail("Webhook URL must have 1 to 2048 characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("Webhook URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("Webhook URL must use http or https.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return fail("Webhook URL must not contain credentials.");
  }

  const common = {
    name: name.value,
    metric: form.metric,
    threshold,
    windowMinutes: windowMinutes.value,
    forMinutes: forMinutes.value,
    minRequests: minRequests.value,
    webhookUrl: url,
    enabled: form.enabled,
  };
  if (form.metric === "slo_burn_rate") {
    if (!/^[1-9][0-9]{0,15}$/.test(form.sloId)) return fail("Choose an SLO.");
    return { ok: true, body: { ...common, sloId: form.sloId } };
  }
  const service = checkedText(form.service, "Service", 256);
  if (!service.ok) return fail(service.message);
  let route: string | null = null;
  if (form.route.trim() !== "") {
    const r = checkedText(form.route, "Route", 512);
    if (!r.ok) return fail(r.message);
    route = r.value;
  }
  return { ok: true, body: { ...common, service: service.value, route } };
}
