/**
 * Dependencies and the request timeline (P9-05), built from the traces in the store, so both
 * reflect sampling. Pure apart from reading the store; never throws.
 */
import { targetOf } from "./app-map.js";
import type {
  DependenciesResponse,
  DependencyPoint,
  DependencyStats,
  MapNode,
  TraceTimelineResponse,
} from "./protocol-types.js";
import {
  isErrorSpan,
  statusCodeOf,
  type TraceFilter,
  type TraceStore,
} from "./store.js";

/** Targets in one response; the rest are left out (they have the least total time). */
export const MAX_DEPENDENCIES = 200;
const MINUTE_MS = 60_000;

/** Bucket width of a window: 1 minute for 15 minutes, 5 minutes for 60. */
export const bucketMsFor = (windowMinutes: number): number =>
  (windowMinutes <= 15 ? 1 : 5) * MINUTE_MS;

/** The aligned buckets covering the window that ends at `now`: first start and count. */
export function bucketsOf(
  windowMinutes: number,
  now: number,
): { bucketMs: number; first: number; count: number } {
  const bucketMs = bucketMsFor(windowMinutes);
  const count = (windowMinutes * MINUTE_MS) / bucketMs;
  const first = (Math.floor(now / bucketMs) - count + 1) * bucketMs;
  return { bucketMs, first, count };
}

/** Nearest-rank percentile of an ascending array. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

const sortedCopy = (xs: readonly number[]) => xs.slice().sort((a, b) => a - b);

interface Acc {
  node: MapNode;
  errors: number;
  durations: number[];
  totalMs: number;
  slowestMs: number;
  exampleTraceId: string | undefined;
  perBucket: number[][];
}

export function buildDependencies(
  store: TraceStore | undefined,
  windowMinutes: number,
  now: number,
): DependenciesResponse {
  const { bucketMs, first, count } = bucketsOf(windowMinutes, now);
  const targets = new Map<string, Acc>();
  try {
    store?.scanTraces(first, (_root, spans, _resource, traceId) => {
      for (const span of spans) {
        const node = targetOf(span);
        if (node === undefined) continue;
        const at = span.startTimeUnixMs;
        if (at < first || at > now) continue;
        let acc = targets.get(node.id);
        if (acc === undefined) {
          acc = {
            node,
            errors: 0,
            durations: [],
            totalMs: 0,
            slowestMs: -1,
            exampleTraceId: undefined,
            perBucket: Array.from({ length: count }, () => []),
          };
          targets.set(node.id, acc);
        }
        if (span.status.code === "error") acc.errors++;
        acc.durations.push(span.durationMs);
        acc.totalMs += span.durationMs;
        if (span.durationMs > acc.slowestMs) {
          acc.slowestMs = span.durationMs;
          acc.exampleTraceId = traceId;
        }
        const bucket = Math.min(
          count - 1,
          Math.max(0, Math.floor((at - first) / bucketMs)),
        );
        (acc.perBucket[bucket] as number[]).push(span.durationMs);
      }
    });
  } catch {
    // Answer with what was gathered.
  }
  const dependencies: DependencyStats[] = [...targets.values()]
    .sort((a, b) => b.totalMs - a.totalMs || (a.node.id < b.node.id ? -1 : 1))
    .slice(0, MAX_DEPENDENCIES)
    .map((acc) => {
      const sorted = sortedCopy(acc.durations);
      const series: DependencyPoint[] = acc.perBucket.map((d, i) => ({
        startUnixMs: first + i * bucketMs,
        calls: d.length,
        p95Ms: quantile(sortedCopy(d), 0.95),
      }));
      const item: DependencyStats = {
        id: acc.node.id,
        kind: acc.node.kind,
        name: acc.node.name,
        calls: sorted.length,
        errors: acc.errors,
        errorRate: sorted.length === 0 ? 0 : acc.errors / sorted.length,
        totalMs: acc.totalMs,
        p50Ms: quantile(sorted, 0.5),
        p95Ms: quantile(sorted, 0.95),
        series,
      };
      if (acc.node.system !== undefined) item.system = acc.node.system;
      if (acc.exampleTraceId !== undefined) {
        item.exampleTraceId = acc.exampleTraceId;
      }
      return item;
    });
  return {
    windowMinutes,
    fromUnixMs: first,
    toUnixMs: now,
    bucketMs,
    dependencies,
  };
}

export function buildTimeline(
  store: TraceStore | undefined,
  windowMinutes: number,
  now: number,
  filter: TraceFilter,
): TraceTimelineResponse {
  const { bucketMs, first, count } = bucketsOf(windowMinutes, now);
  const buckets = Array.from({ length: count }, (_, i) => ({
    startUnixMs: first + i * bucketMs,
    ok: 0,
    clientError: 0,
    serverError: 0,
  }));
  try {
    store?.scanMatching(
      { ...filter, fromUnixMs: first, toUnixMs: now },
      (root) => {
        const i = Math.floor((root.startTimeUnixMs - first) / bucketMs);
        const bucket = buckets[i];
        if (bucket === undefined) return;
        const code = statusCodeOf(root);
        if (isErrorSpan(root) || (code !== undefined && code >= 500)) {
          bucket.serverError++;
        } else if (code !== undefined && code >= 400) bucket.clientError++;
        else bucket.ok++;
      },
    );
  } catch {
    // Answer with what was gathered.
  }
  return {
    windowMinutes,
    fromUnixMs: first,
    toUnixMs: now,
    bucketMs,
    buckets,
  };
}
