import type { Slo, SloCreate } from "@nestrix-js/protocol";

import { formatDuration } from "@/lib/format";

/**
 * A fraction as a percentage with as many decimals as it needs (at most 3), trailing zeros
 * dropped. A value below 1 never shows as "100%", and one above 0 never as "0%".
 */
export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "-";
  const percent = fraction * 100;
  let text = trim(percent.toFixed(3));
  if (fraction < 1 && Number(text) >= 100) text = "99.999";
  if (fraction > 0 && Number(text) <= 0) text = "0.001";
  return `${text}%`;
}

function trim(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** `14.4x`, with one decimal below 100 and none above; "-" without data. */
export function formatBurnRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "-";
  return `${rate >= 100 ? Math.round(rate) : trim(rate.toFixed(1))}x`;
}

export type BudgetState = "none" | "ok" | "low" | "spent";

/** `none` without requests, `spent` at or below 0, `low` under a quarter, else `ok`. */
export function budgetState(remainingFraction: number | null): BudgetState {
  if (remainingFraction === null) return "none";
  if (remainingFraction <= 0) return "spent";
  return remainingFraction < 0.25 ? "low" : "ok";
}

/** Width of the budget bar, 0 to 100 (an overspent budget is an empty bar). */
export function budgetBarPercent(remainingFraction: number | null): number {
  if (remainingFraction === null) return 0;
  return Math.round(Math.min(1, Math.max(0, remainingFraction)) * 100);
}

/** "98.4% of the budget left", "budget overspent by 40%", or "no requests yet". */
export function describeBudget(remainingFraction: number | null): string {
  if (remainingFraction === null) return "no requests in the window";
  if (remainingFraction < 0)
    return `budget overspent by ${trim((-remainingFraction * 100).toFixed(1))}%`;
  return `${trim((remainingFraction * 100).toFixed(1))}% of the budget left`;
}

/** What counts as a good request, in words. */
export function describeIndicator(
  slo: Pick<Slo, "kind" | "latencyThresholdMs">,
): string {
  return slo.kind === "latency" && slo.latencyThresholdMs !== null
    ? `requests faster than ${formatDuration(slo.latencyThresholdMs)}`
    : "requests that are not errors (no 5xx)";
}

export interface SloForm {
  name: string;
  service: string;
  route: string;
  kind: "availability" | "latency";
  latencyThresholdMs: string;
  /** In percent, e.g. "99.9". */
  objectivePercent: string;
  windowDays: "7" | "30";
}

export const emptyForm = (service = ""): SloForm => ({
  name: "",
  service,
  route: "",
  kind: "availability",
  latencyThresholdMs: "",
  objectivePercent: "99.9",
  windowDays: "30",
});

export function formFromSlo(slo: Slo): SloForm {
  return {
    name: slo.name,
    service: slo.service,
    route: slo.route ?? "",
    kind: slo.kind,
    latencyThresholdMs:
      slo.latencyThresholdMs === null ? "" : String(slo.latencyThresholdMs),
    objectivePercent: trim((slo.objective * 100).toFixed(4)),
    windowDays: String(slo.windowDays) as "7" | "30",
  };
}

/** The request body for a form, or the first problem in it. */
export function toRequest(
  form: SloForm,
): { ok: true; body: SloCreate } | { ok: false; message: string } {
  const name = form.name.trim();
  if (name === "") return { ok: false, message: "Give the SLO a name." };
  const service = form.service.trim();
  if (service === "") return { ok: false, message: "Choose a service." };
  const percent = Number(form.objectivePercent);
  if (
    form.objectivePercent.trim() === "" ||
    !Number.isFinite(percent) ||
    percent <= 0 ||
    percent >= 100
  ) {
    return {
      ok: false,
      message: "The objective is a percentage above 0 and below 100.",
    };
  }
  const route = form.route.trim();
  const body: SloCreate = {
    name,
    service,
    route: route === "" ? null : route,
    kind: form.kind,
    // Dividing 99.9 by 100 is not exact; the server compares against what is stored.
    objective: Number((percent / 100).toPrecision(12)),
    windowDays: form.windowDays === "7" ? 7 : 30,
  };
  if (form.kind === "latency") {
    const ms = Number(form.latencyThresholdMs);
    if (
      form.latencyThresholdMs.trim() === "" ||
      !Number.isFinite(ms) ||
      ms <= 0 ||
      ms > 3_600_000
    ) {
      return {
        ok: false,
        message: "The latency threshold is a number of milliseconds above 0.",
      };
    }
    body.latencyThresholdMs = ms;
  }
  return { ok: true, body };
}
