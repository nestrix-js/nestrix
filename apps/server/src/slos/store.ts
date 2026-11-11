/** API shapes of SLO rows and strict validation of API input. */
import type { Slo, SloCreate, SloStatus } from "@nestrix/protocol";
import type { SloRow } from "./compute.js";

export function toApiSlo(row: SloRow, status: SloStatus): Slo {
  return {
    id: String(row.id),
    name: row.name,
    service: row.service_name,
    route: row.route,
    kind: row.kind,
    latencyThresholdMs: row.latency_threshold_ms,
    objective: row.objective,
    windowDays: row.window_days,
    createdAtUnixMs: row.created_at.getTime(),
    updatedAtUnixMs: row.updated_at.getTime(),
    status,
  };
}

/** Validated fields, in column names. */
export interface SloFields {
  name?: string;
  service_name?: string;
  route?: string | null;
  kind?: "availability" | "latency";
  latency_threshold_ms?: number | null;
  objective?: number;
  window_days?: 7 | 30;
}

export type SloValidation =
  | { ok: true; fields: SloFields }
  | { ok: false; message: string };

const KEYS = new Set<keyof SloCreate>([
  "name",
  "service",
  "route",
  "kind",
  "latencyThresholdMs",
  "objective",
  "windowDays",
]);
const REQUIRED: (keyof SloCreate)[] = [
  "name",
  "service",
  "kind",
  "objective",
  "windowDays",
];

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

/**
 * Checks a create (`partial` false) or update (`partial` true) body. Unknown fields, wrong types
 * and out-of-range values are refused. `latencyThresholdMs` belongs to `latency` SLOs only; on an
 * update the kind and threshold are checked together against `existing`.
 */
export function validateSloInput(
  body: unknown,
  partial: boolean,
  existing?: Pick<SloRow, "kind" | "latency_threshold_ms">,
): SloValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "The body must be a JSON object." };
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key as keyof SloCreate)) {
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
  const fields: SloFields = {};
  const fail = (message: string): SloValidation => ({ ok: false, message });
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
  if (Object.hasOwn(input, "route")) {
    if (input.route === null || input.route === undefined) {
      fields.route = null;
    } else {
      const v = text(input.route, "route", 512);
      if (typeof v !== "string") return fail(v.error);
      fields.route = v;
    }
  }
  if (has("kind")) {
    if (input.kind !== "availability" && input.kind !== "latency") {
      return fail('kind must be "availability" or "latency".');
    }
    fields.kind = input.kind;
  }
  if (has("latencyThresholdMs")) {
    const v = input.latencyThresholdMs;
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v <= 0 ||
      v > 3_600_000
    ) {
      return fail(
        "latencyThresholdMs must be a number of milliseconds above 0 and at most 3600000.",
      );
    }
    fields.latency_threshold_ms = v;
  }
  if (has("objective")) {
    const v = input.objective;
    if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0 && v < 1)) {
      return fail(
        "objective must be a fraction above 0 and below 1, e.g. 0.999.",
      );
    }
    fields.objective = v;
  }
  if (has("windowDays")) {
    if (input.windowDays !== 7 && input.windowDays !== 30) {
      return fail("windowDays must be 7 or 30.");
    }
    fields.window_days = input.windowDays;
  }

  const kind = fields.kind ?? existing?.kind;
  if (kind === "latency") {
    const threshold =
      fields.latency_threshold_ms ?? existing?.latency_threshold_ms ?? null;
    if (threshold === null) {
      return fail("latencyThresholdMs is required for a latency SLO.");
    }
  } else if (kind === "availability") {
    if (fields.latency_threshold_ms !== undefined) {
      return fail("latencyThresholdMs is only for a latency SLO.");
    }
    // Switching to availability drops the stored threshold.
    if (partial && existing?.kind === "latency") {
      fields.latency_threshold_ms = null;
    }
  }
  return { ok: true, fields };
}
