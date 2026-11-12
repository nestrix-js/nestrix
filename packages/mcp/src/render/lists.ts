import type {
  AppMapResponse,
  ClassStatsResponse,
  ErrorListResponse,
  MetaResponse,
  RouteStats,
  RouteStatsResponse,
  TraceListResponse,
} from "@nestrix-js/protocol";
import {
  fmtMs,
  fmtPct,
  fmtTime,
  oneLine,
  plural,
  table,
  truncate,
} from "./format.js";

/** Rows shown in a statistics table. */
export const MAX_ROWS = 25;

export function renderTraceList(
  list: TraceListResponse,
  filters: string,
): string {
  if (list.items.length === 0) {
    return `No stored traces match${filters ? ` (${filters})` : ""}. Traces are sampled and the store is in memory, so older or unsampled requests are not here; route_stats counts every request.`;
  }
  const rows = list.items.map((t) => {
    const what = t.method && t.route ? `${t.method} ${t.route}` : t.name;
    const tags = [
      t.error ? "ERROR" : "",
      t.hasJob ? "job" : "",
      t.type !== "http" ? t.type : "",
    ].filter(Boolean);
    const extra = [
      tags.join(","),
      t.release ? `release ${t.release}` : "",
      t.user ? `user ${truncate(t.user, 40)}` : "",
    ].filter(Boolean);
    return [
      t.traceId,
      fmtTime(t.startTimeUnixMs),
      truncate(oneLine(what), 80),
      t.statusCode === undefined ? "-" : String(t.statusCode),
      fmtMs(t.durationMs),
      `${t.spanCount} spans`,
      extra.join(" "),
    ];
  });
  const lines = [
    `${plural(list.items.length, "trace")}${filters ? ` (${filters})` : ""}, newest first. Pass a trace id to get_trace.`,
    ...table([
      ["trace id", "start (UTC)", "request", "status", "duration", "size", ""],
      ...rows,
    ]),
  ];
  if (list.older !== null) {
    lines.push(
      "More matching traces exist; narrow the filters (route, minDurationMs, search) to find others.",
    );
  }
  return lines.join("\n");
}

export function renderErrors(list: ErrorListResponse, route?: string): string {
  if (list.items.length === 0) {
    return `No stored errors${route ? ` for ${route}` : ""}.`;
  }
  const groups = new Map<
    string,
    { count: number; latest: number; traceId: string }
  >();
  for (const e of list.items) {
    const key = `${e.errorType ?? e.spanName}: ${truncate(oneLine(e.message ?? ""), 160)}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (e.timeUnixMs > g.latest) {
        g.latest = e.timeUnixMs;
        g.traceId = e.traceId;
      }
    } else {
      groups.set(key, { count: 1, latest: e.timeUnixMs, traceId: e.traceId });
    }
  }
  const lines = [
    `${plural(list.items.length, "error")}${route ? ` for ${route}` : ""}, newest first${list.older !== null ? " (more exist)" : ""}.`,
    "",
    "Grouped by type and message:",
  ];
  const ranked = [...groups.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].latest - a[1].latest,
  );
  for (const [key, g] of ranked.slice(0, 10)) {
    lines.push(`- ${g.count}x ${key} (latest trace ${g.traceId})`);
  }
  lines.push("", "Each error:");
  lines.push(
    ...table(
      list.items.map((e) => [
        fmtTime(e.timeUnixMs),
        truncate(
          oneLine(
            e.method && e.route
              ? `${e.method} ${e.route}`
              : (e.route ?? e.spanName),
          ),
          60,
        ),
        e.statusCode === undefined ? "-" : String(e.statusCode),
        e.traceId,
      ]),
    ),
  );
  lines.push("Pass a trace id to get_trace for the stack frames.");
  return lines.join("\n");
}

function routeLine(r: RouteStats): string[] {
  return [
    `${r.method} ${r.route}`,
    String(r.count),
    String(r.errors),
    fmtPct(r.errors, r.count),
    fmtMs(r.p50Ms),
    fmtMs(r.p95Ms),
    fmtMs(r.p99Ms),
    fmtMs(r.maxMs),
  ];
}

export function renderRoutes(stats: RouteStatsResponse): string {
  if (stats.routes.length === 0) {
    return `No requests counted in the last ${stats.windowMinutes} minutes.`;
  }
  const sorted = [...stats.routes].sort(
    (a, b) =>
      b.p95Ms - a.p95Ms ||
      (`${a.method} ${a.route}` < `${b.method} ${b.route}` ? -1 : 1),
  );
  const shown = sorted.slice(0, MAX_ROWS);
  const lines = [
    `Routes over the last ${stats.windowMinutes} minutes, slowest p95 first. Every request is counted, sampled or not.`,
    ...table([
      ["route", "requests", "errors", "error rate", "p50", "p95", "p99", "max"],
      ...shown.map(routeLine),
    ]),
  ];
  if (sorted.length > shown.length) {
    lines.push(`... ${sorted.length - shown.length} more routes not shown.`);
  }
  return lines.join("\n");
}

export function renderClasses(stats: ClassStatsResponse): string {
  if (!stats.methodsEnabled) {
    return "Method spans are off in this app (no NestrixInstrument, or it runs under @nestjs/testing), so there are no per-class statistics.";
  }
  if (stats.classes.length === 0) {
    return `No traced class calls in the last ${stats.windowMinutes} minutes.`;
  }
  const sorted = [...stats.classes].sort(
    (a, b) =>
      (b.ownMs ?? -1) - (a.ownMs ?? -1) ||
      b.totalMs - a.totalMs ||
      (a.className < b.className ? -1 : 1),
  );
  const shown = sorted.slice(0, MAX_ROWS);
  const lines = [
    `Classes over the last ${stats.windowMinutes} minutes, most own time first. Own time is estimated from the sampled traces in the store; calls and errors are counted before sampling.`,
    ...table([
      ["class", "kind", "calls", "errors", "avg", "own time"],
      ...shown.map((c) => [
        c.className,
        c.kind,
        String(c.calls),
        String(c.errors),
        fmtMs(c.avgMs),
        c.ownMs === null ? "-" : fmtMs(c.ownMs),
      ]),
    ]),
  ];
  const top = shown.slice(0, 5);
  lines.push("", "Slowest methods of the top classes:");
  for (const c of top) {
    const methods = [...c.methods]
      .sort((a, b) => b.totalMs - a.totalMs || (a.method < b.method ? -1 : 1))
      .slice(0, 3)
      .map(
        (m) =>
          `${m.method} ${m.calls} calls avg ${fmtMs(m.avgMs)} max ${fmtMs(m.maxMs)}${m.errors > 0 ? ` ${m.errors} errors` : ""}`,
      );
    lines.push(`- ${c.className}: ${methods.join("; ")}`);
  }
  if (sorted.length > shown.length) {
    lines.push(`... ${sorted.length - shown.length} more classes not shown.`);
  }
  return lines.join("\n");
}

export function renderMap(map: AppMapResponse): string {
  if (map.edges.length === 0) {
    return `No calls between the app and other systems in the stored traces of the last ${map.windowMinutes} minutes.`;
  }
  const names = new Map(map.nodes.map((n) => [n.id, n]));
  const label = (id: string): string => {
    const n = names.get(id);
    return n ? `${n.name} (${n.kind})` : id;
  };
  const edges = [...map.edges].sort(
    (a, b) => b.calls - a.calls || (a.to < b.to ? -1 : 1),
  );
  const lines = [
    `App map from the sampled traces of the last ${map.windowMinutes} minutes (call counts reflect sampling):`,
    ...edges
      .slice(0, MAX_ROWS)
      .map(
        (e) =>
          `- ${label(e.from)} -> ${label(e.to)}: ${plural(e.calls, "call")}, ${plural(e.errors, "error")}, p50 ${fmtMs(e.p50Ms)}, p95 ${fmtMs(e.p95Ms)}`,
      ),
  ];
  if (edges.length > MAX_ROWS) {
    lines.push(`... ${edges.length - MAX_ROWS} more edges not shown.`);
  }
  return lines.join("\n");
}

export interface OverviewInput {
  meta: MetaResponse;
  routes: RouteStatsResponse | undefined;
  errors: ErrorListResponse | undefined;
}

export function renderOverview(input: OverviewInput): string {
  const { meta, routes, errors } = input;
  const lines: string[] = [];
  const service = meta.service;
  lines.push(
    `Nestrix ${meta.mode === "standalone" ? "server (standalone)" : "dashboard (embedded in one app)"}${service.name ? `: ${service.name}` : ""}${service.version ? ` ${service.version}` : ""}${service.environment ? ` (${service.environment})` : ""}`,
  );
  if (meta.services && meta.services.length > 0) {
    lines.push(
      `Services with data: ${meta.services.join(", ")} (filter other tools with service)`,
    );
  }
  lines.push(
    `Sampling: ${meta.sampling.owner === "nestrix" ? `${trimRate(meta.sampling.rate)} of requests are stored as traces` : "owned by the host app (rate unknown)"}; route statistics count every request.`,
  );
  lines.push(
    `Store: ${meta.store.traces}/${meta.store.maxTraces} traces, ${meta.store.spans} spans, ${meta.store.evictedTraces} evicted, ${meta.store.droppedSpans} spans dropped.`,
  );
  lines.push(
    `CPU profiler: ${meta.profiler.available ? (meta.profiler.running ? "available, a capture is running" : "available (start_profile)") : "not available here (embedded dashboards only)"}.`,
  );
  for (const w of meta.warnings) lines.push(`Warning: ${oneLine(w.message)}`);

  if (routes) {
    const withTraffic = routes.routes.filter((r) => r.count > 0);
    const total = withTraffic.reduce((n, r) => n + r.count, 0);
    const failed = withTraffic.reduce((n, r) => n + r.errors, 0);
    lines.push(
      "",
      `Traffic in the last ${routes.windowMinutes} minutes: ${plural(total, "request")}, ${plural(failed, "error")} (${fmtPct(failed, total)}).`,
    );
    const slowest = [...withTraffic]
      .sort(
        (a, b) =>
          b.p95Ms - a.p95Ms ||
          (`${a.method} ${a.route}` < `${b.method} ${b.route}` ? -1 : 1),
      )
      .slice(0, 5);
    if (slowest.length > 0) {
      lines.push("Slowest routes (p95):");
      for (const r of slowest) {
        lines.push(
          `- ${r.method} ${r.route}: p95 ${fmtMs(r.p95Ms)}, p50 ${fmtMs(r.p50Ms)}, ${plural(r.count, "request")}`,
        );
      }
    }
    const failing = withTraffic
      .filter((r) => r.errors > 0)
      .sort(
        (a, b) =>
          b.errors / b.count - a.errors / a.count ||
          b.errors - a.errors ||
          (`${a.method} ${a.route}` < `${b.method} ${b.route}` ? -1 : 1),
      )
      .slice(0, 5);
    if (failing.length > 0) {
      lines.push("Most failing routes:");
      for (const r of failing) {
        lines.push(
          `- ${r.method} ${r.route}: ${r.errors}/${r.count} failed (${fmtPct(r.errors, r.count)})`,
        );
      }
    } else if (withTraffic.length > 0) {
      lines.push("No failing routes in this window.");
    }
  } else {
    lines.push("", "Route statistics could not be read.");
  }
  if (errors) {
    const n = errors.items.length;
    lines.push(
      `Stored errors: ${n}${errors.older !== null ? "+" : ""}${n > 0 ? " (list_errors)" : ""}.`,
    );
  } else {
    lines.push("Stored errors could not be read.");
  }
  lines.push(
    "",
    "Next: find_traces or explain_slowness for a slow route, list_errors then get_trace for a failure, class_stats and app_map for structure.",
  );
  return lines.join("\n");
}

function trimRate(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
