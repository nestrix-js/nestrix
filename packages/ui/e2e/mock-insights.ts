// Dependencies and request timeline answers for the mock API (docs/backlog/phase-9.md P9-05
// shapes). Generated for any window; not the backend code.
import type {
  DependenciesResponse,
  DependencyStats,
  TraceTimelineResponse,
} from "@nestrix-js/protocol";

const MINUTE = 60_000;

/** The aligned buckets of a window ending at `now`, as the backends compute them. */
export function bucketsOf(windowMinutes: number, now: number) {
  const bucketMs = (windowMinutes <= 15 ? 1 : 5) * MINUTE;
  const count = (windowMinutes * MINUTE) / bucketMs;
  const first = (Math.floor(now / bucketMs) - count + 1) * bucketMs;
  return { bucketMs, count, first };
}

/** Counts that vary by bucket; the last bucket is empty so a test can tell it from the others. */
export function generatedTimeline(
  windowMinutes: number,
  now = Date.now(),
): TraceTimelineResponse {
  const { bucketMs, count, first } = bucketsOf(windowMinutes, now);
  return {
    windowMinutes,
    fromUnixMs: first,
    toUnixMs: now,
    bucketMs,
    buckets: Array.from({ length: count }, (_, i) => ({
      startUnixMs: first + i * bucketMs,
      ok: i === count - 1 ? 0 : 4 + ((i * 3) % 7),
      clientError: i % 4 === 0 && i < count - 1 ? 2 : 0,
      serverError: i % 5 === 0 && i < count - 1 ? 3 : 0,
    })),
  };
}

const dependency = (
  windowMinutes: number,
  now: number,
  d: Omit<DependencyStats, "series" | "errorRate" | "totalMs"> & {
    avgMs: number;
  },
): DependencyStats => {
  const { avgMs, ...rest } = d;
  const { bucketMs, count, first } = bucketsOf(windowMinutes, now);
  return {
    ...rest,
    errorRate: d.calls === 0 ? 0 : d.errors / d.calls,
    totalMs: d.calls * avgMs,
    series: Array.from({ length: count }, (_, i) => ({
      startUnixMs: first + i * bucketMs,
      calls: Math.round(d.calls / count) + (i % 3),
      p95Ms: d.p95Ms * (0.6 + ((i * 7) % 5) / 10),
    })),
  };
};

/** Four targets, one of each main kind, deliberately not in total-time order. */
export function generatedDependencies(
  windowMinutes: number,
  now = Date.now(),
): DependenciesResponse {
  const { bucketMs, first } = bucketsOf(windowMinutes, now);
  const trace = (n: number) => n.toString(16).padStart(32, "0");
  return {
    windowMinutes,
    fromUnixMs: first,
    toUnixMs: now,
    bucketMs,
    dependencies: [
      dependency(windowMinutes, now, {
        id: "cache:redis:cache.local",
        kind: "cache",
        name: "redis",
        system: "redis",
        calls: 900,
        errors: 0,
        p50Ms: 0.4,
        p95Ms: 1.2,
        avgMs: 0.6,
        exampleTraceId: trace(11),
      }),
      dependency(windowMinutes, now, {
        id: "db:postgresql:db.local:5432/shop",
        kind: "database",
        name: "postgresql shop",
        system: "postgresql",
        calls: 240,
        errors: 12,
        p50Ms: 8,
        p95Ms: 90,
        avgMs: 20,
        exampleTraceId: trace(12),
      }),
      dependency(windowMinutes, now, {
        id: "http:api.stripe.com",
        kind: "http",
        name: "api.stripe.com",
        system: "http",
        calls: 30,
        errors: 3,
        p50Ms: 180,
        p95Ms: 420,
        avgMs: 220,
        exampleTraceId: trace(13),
      }),
      dependency(windowMinutes, now, {
        id: "queue:rabbitmq:emails",
        kind: "queue",
        name: "queue emails",
        system: "rabbitmq",
        calls: 50,
        errors: 0,
        p50Ms: 2,
        p95Ms: 6,
        avgMs: 3,
      }),
    ],
  };
}
