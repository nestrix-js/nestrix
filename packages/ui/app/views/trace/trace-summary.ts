import type { SpanRecord, TraceResponse } from "@nestrix-js/protocol";

import { buildTree, isErrorSpan } from "@/lib/trace-tree";

export interface TraceSummary {
  /** The root's route and method, for the link to the route detail page. */
  route: string | undefined;
  method: string | undefined;
  title: string;
  statusCode: number | undefined;
  error: boolean;
  durationMs: number;
  startMs: number;
  /** The root span's service, else the resource's `service.name`. */
  service: string | undefined;
  /** `service.version` of the trace's resource. */
  release: string | undefined;
  /** `user.id` of the root span, when the app recorded one. */
  user: string | undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Route, status, duration, service, release and user come from the trace's local root span and resource. */
export function summarizeTrace(trace: TraceResponse): TraceSummary {
  const root: SpanRecord | undefined =
    trace.spans.find((s) => s.spanId === trace.rootSpanId) ?? trace.spans[0];
  const attrs = root?.attributes ?? {};
  const method = text(attrs["http.request.method"]);
  const route = text(attrs["http.route"]);
  const code = attrs["http.response.status_code"];
  const tree = buildTree(trace.spans, trace.rootSpanId);
  return {
    route,
    method,
    title:
      route !== undefined
        ? `${method !== undefined ? `${method} ` : ""}${route}`
        : (root?.name ?? "Trace"),
    statusCode: typeof code === "number" ? code : undefined,
    error: root
      ? isErrorSpan(root) || (typeof code === "number" && code >= 500)
      : false,
    durationMs: root?.durationMs ?? tree.totalMs,
    startMs: root?.startTimeUnixMs ?? tree.startMs,
    service: text(root?.service) ?? text(trace.resource["service.name"]),
    release: text(trace.resource["service.version"]),
    user: text(attrs["user.id"]),
  };
}
