// Class statistics and app map answers for the mock API (docs/backlog/phase-3.md P3-04/P3-05
// shapes). Generated for any window; not the backend code.
import type {
  AppMapResponse,
  ClassStats,
  ClassStatsResponse,
  MethodStats,
} from "@nestrix/protocol";

const method = (
  name: string,
  calls: number,
  errors: number,
  avgMs: number,
  ownAvgMs: number | null,
): MethodStats => ({
  method: name,
  calls,
  errors,
  totalMs: calls * avgMs,
  avgMs,
  maxMs: avgMs * 4,
  ownAvgMs,
});

const sum = (methods: MethodStats[]) => {
  const calls = methods.reduce((a, m) => a + m.calls, 0);
  const totalMs = methods.reduce((a, m) => a + m.totalMs, 0);
  const owned = methods.filter((m) => m.ownAvgMs !== null);
  return {
    calls,
    errors: methods.reduce((a, m) => a + m.errors, 0),
    totalMs,
    avgMs: calls === 0 ? 0 : totalMs / calls,
    ownMs:
      owned.length === 0
        ? null
        : owned.reduce((a, m) => a + (m.ownAvgMs ?? 0) * m.calls, 0),
  };
};

const cls = (
  className: string,
  kind: ClassStats["kind"],
  methods: MethodStats[],
): ClassStats => ({ className, kind, ...sum(methods), methods });

/** Window-dependent: the 60 minute answer has four times the calls. */
export function generatedClasses(windowMinutes: number): ClassStatsResponse {
  const k = windowMinutes === 60 ? 4 : 1;
  return {
    windowMinutes,
    fromUnixMs: 0,
    toUnixMs: 0,
    methodsEnabled: true,
    classes: [
      cls("OrdersController", "controller", [
        method("list", 40 * k, 0, 12, 2),
        method("create", 10 * k, 3, 80, 5),
      ]),
      cls("OrdersService", "service", [
        method("findAll", 40 * k, 0, 9, 3),
        method("place", 10 * k, 3, 70, 20),
        method("audit", 5 * k, 0, 1, null),
      ]),
      cls("OrdersRepository", "repository", [method("query", 50 * k, 0, 6, 6)]),
      cls("AuthGuard", "guard", [method("canActivate", 50 * k, 0, 0.5, null)]),
    ],
  };
}

export const classesDisabled = (windowMinutes: number): ClassStatsResponse => ({
  windowMinutes,
  fromUnixMs: 0,
  toUnixMs: 0,
  methodsEnabled: false,
  classes: [],
});

export const classesEmpty = (windowMinutes: number): ClassStatsResponse => ({
  ...classesDisabled(windowMinutes),
  methodsEnabled: true,
});

export function generatedMap(windowMinutes: number): AppMapResponse {
  const k = windowMinutes === 60 ? 4 : 1;
  return {
    windowMinutes,
    fromUnixMs: 0,
    toUnixMs: 0,
    nodes: [
      { id: "app", kind: "app", name: "demo-service" },
      {
        id: "db:postgresql:shop",
        kind: "database",
        name: "postgresql shop",
        system: "postgresql",
      },
      { id: "cache:redis", kind: "cache", name: "redis", system: "redis" },
      {
        id: "http:api.stripe.com",
        kind: "http",
        name: "api.stripe.com",
        system: "http",
      },
      {
        id: "queue:emails",
        kind: "queue",
        name: "queue emails",
        system: "bullmq",
      },
    ],
    edges: [
      {
        from: "app",
        to: "db:postgresql:shop",
        calls: 120 * k,
        errors: 0,
        p50Ms: 4,
        p95Ms: 21,
      },
      {
        from: "app",
        to: "cache:redis",
        calls: 300 * k,
        errors: 1,
        p50Ms: 0.4,
        p95Ms: 1.2,
      },
      {
        from: "app",
        to: "http:api.stripe.com",
        calls: 20 * k,
        errors: 4,
        p50Ms: 180,
        p95Ms: 900,
      },
      {
        from: "app",
        to: "queue:emails",
        calls: 15 * k,
        errors: 0,
        p50Ms: 2,
        p95Ms: 6,
      },
    ],
  };
}

export const mapEmpty = (windowMinutes: number): AppMapResponse => ({
  windowMinutes,
  fromUnixMs: 0,
  toUnixMs: 0,
  nodes: [{ id: "app", kind: "app", name: "demo-service" }],
  edges: [],
});
