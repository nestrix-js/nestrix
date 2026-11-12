import type { InstanceSummary } from "@nestrix-js/protocol";

import { formatBytes, formatMs } from "@/views/profiler/profile-format";

/**
 * The "Suggested" chip on the standalone Profiler's instances table (P15-03, D-80).
 *
 * The rule, per service (instances of different services do different work, so they are never
 * compared with each other):
 *
 * 1. CPU first: among the instances of the service whose latest check-in reported `cpuPercent`,
 *    if there are at least two, the highest is suggested when it is clearly higher than the
 *    second: at least 1.5 times it and at least 10 percentage points above it.
 * 2. Otherwise event-loop delay: the same with `eventLoopP99Ms`, at least 1.5 times the second
 *    and at least 20 ms above it.
 * 3. Otherwise no suggestion for that service.
 *
 * Both thresholds must hold, so two idle instances (1% against 0.4%) or two busy ones close to
 * each other (80% against 70%) get no chip. A CPU profile shows where the main thread spends its
 * time, which is what both figures point at; CPU goes first because it is what the capture
 * measures directly.
 */
export const SUGGEST_RATIO = 1.5;
export const SUGGEST_MIN_CPU_POINTS = 10;
export const SUGGEST_MIN_LOOP_MS = 20;

export type SuggestReason = "cpu" | "loop";

export interface Suggestion {
  service: string;
  instanceId: string;
  reason: SuggestReason;
  /** The suggested instance's figure and the next highest, for the tooltip. */
  value: number;
  runnerUp: number;
}

/** The key the page uses for a row: service and instance id. */
export const instanceKey = (
  i: Pick<InstanceSummary, "service" | "instanceId">,
) => `${i.service}\u0000${i.instanceId}`;

function clearLeader(
  instances: InstanceSummary[],
  pick: (i: InstanceSummary) => number | undefined,
  minGap: number,
): { leader: InstanceSummary; value: number; runnerUp: number } | null {
  const reporting = instances
    .map((instance) => ({ instance, value: pick(instance) }))
    .filter(
      (r): r is { instance: InstanceSummary; value: number } =>
        typeof r.value === "number" && Number.isFinite(r.value) && r.value >= 0,
    )
    .sort((a, b) => b.value - a.value);
  const [top, second] = reporting;
  if (top === undefined || second === undefined) return null;
  if (top.value - second.value < minGap) return null;
  if (top.value < second.value * SUGGEST_RATIO) return null;
  return { leader: top.instance, value: top.value, runnerUp: second.value };
}

/** One suggestion per service at most, keyed by `instanceKey`. */
export function suggestInstances(
  instances: InstanceSummary[],
): Map<string, Suggestion> {
  const byService = new Map<string, InstanceSummary[]>();
  for (const instance of instances) {
    const group = byService.get(instance.service);
    if (group) group.push(instance);
    else byService.set(instance.service, [instance]);
  }
  const out = new Map<string, Suggestion>();
  for (const [service, group] of byService) {
    const cpu = clearLeader(
      group,
      (i) => i.runtimeSample?.cpuPercent,
      SUGGEST_MIN_CPU_POINTS,
    );
    const found =
      cpu ??
      clearLeader(
        group,
        (i) => i.runtimeSample?.eventLoopP99Ms,
        SUGGEST_MIN_LOOP_MS,
      );
    if (found === null) continue;
    out.set(instanceKey(found.leader), {
      service,
      instanceId: found.leader.instanceId,
      reason: cpu ? "cpu" : "loop",
      value: found.value,
      runnerUp: found.runnerUp,
    });
  }
  return out;
}

/** `0.4%`, `37%`, `140%` (of one core). */
export function formatCpu(percent: number): string {
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** The chip's tooltip: why this instance. */
export function suggestionTitle(s: Suggestion): string {
  return s.reason === "cpu"
    ? `Highest CPU among the ${s.service} instances: ${formatCpu(s.value)} of a core against ${formatCpu(s.runnerUp)} for the next. A capture here shows where that time goes.`
    : `Highest event-loop delay (p99) among the ${s.service} instances: ${formatMs(s.value)} against ${formatMs(s.runnerUp)} for the next. A capture here shows what blocks the loop.`;
}

/** Shown in a runtime cell with no figure. */
export const NO_FIGURE = "—";

export const formatRuntimeBytes = (bytes: number | undefined) =>
  bytes === undefined ? NO_FIGURE : formatBytes(Math.round(bytes));

/** The largest value of a figure across rows, for a column's bars; at least `floor`. */
export function columnMax(
  instances: InstanceSummary[],
  pick: (i: InstanceSummary) => number | undefined,
  floor: number,
): number {
  let max = floor;
  for (const i of instances) {
    const v = pick(i);
    if (typeof v === "number" && Number.isFinite(v) && v > max) max = v;
  }
  return max;
}
