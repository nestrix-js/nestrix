/**
 * `GET api/v1/routes/explain` on the embedded dashboard: gathers the sampled traces of one route
 * from the trace store, classifies their spans with the same code the overview, Queries and
 * Dependencies pages use, and calls `computeExplain`. Never throws.
 */
import type { RouteExplainResponse } from "@nestrix-js/protocol";
import { timeKeyOf } from "../overview/compute.js";
import { factsOf } from "../overview/embedded.js";
import { ATTR_CLASS, ATTR_METHOD } from "../stats/class-stats.js";
import { BUCKET_MS } from "../stats/route-stats.js";
import { targetOf } from "../store/app-map.js";
import type { MapNodeKind, SpanRecord } from "../store/protocol-types.js";
import { statementOf } from "../store/queries.js";
import { isErrorSpan, statusCodeOf, type TraceStore } from "../store/store.js";
import {
  computeExplain,
  type ExplainSideInput,
  type ExplainSpanInput,
  type ExplainTraceInput,
  MAX_TRACES_PER_SIDE,
} from "./compute.js";

const MAX_RELEASES = 20;
/** Spans kept per side: the newest traces whose span counts add up to this (job traces are huge). */
export const MAX_SPANS_PER_SIDE = 200_000;

/** Drops the oldest traces of a side while it holds more than the span cap (keeps at least one). */
export function trimSpans(side: ExplainSideInput): void {
  let spans = 0;
  for (const t of side.traces) spans += t.spans.length;
  let drop = 0;
  while (spans > MAX_SPANS_PER_SIDE && drop < side.traces.length - 1) {
    spans -= (side.traces[drop] as ExplainTraceInput).spans.length;
    drop++;
  }
  if (drop > 0) side.traces = side.traces.slice(drop);
}

const DEPENDENCY_KIND: Partial<
  Record<MapNodeKind, "http" | "db" | "redis" | "messaging">
> = {
  http: "http",
  database: "db",
  cache: "redis",
  queue: "messaging",
};

function spanInput(span: SpanRecord): ExplainSpanInput {
  const out: ExplainSpanInput = {
    spanId: span.spanId,
    durationMs: span.durationMs,
    error: span.status.code === "error",
    key: timeKeyOf(factsOf(span)),
    exceptions: [],
  };
  if (span.parentSpanId !== undefined) out.parentSpanId = span.parentSpanId;
  const statement = statementOf(span);
  if (statement !== undefined) out.statement = statement;
  const cls = span.attributes[ATTR_CLASS];
  const method = span.attributes[ATTR_METHOD];
  if (typeof cls === "string" && typeof method === "string") {
    out.method = `${cls}.${method}`;
  }
  const node = targetOf(span);
  const kind = node === undefined ? undefined : DEPENDENCY_KIND[node.kind];
  if (node !== undefined && kind !== undefined) {
    out.dependency = { name: node.name, kind };
  }
  for (const e of span.events) {
    if (e.name !== "exception") continue;
    const type = e.attributes["exception.type"];
    const message = e.attributes["exception.message"];
    out.exceptions.push({
      ...(typeof type === "string" ? { type } : {}),
      ...(typeof message === "string" ? { message } : {}),
    });
  }
  return out;
}

export interface ExplainRequest {
  method: string | undefined;
  route: string;
  windowMinutes: number;
  releaseA: string | undefined;
  releaseB: string | undefined;
}

/** `none`: a `service` filter names another service, so the answer is empty. */
export function buildEmbeddedExplain(
  store: TraceStore | undefined,
  req: ExplainRequest,
  now: number,
  none: boolean,
): RouteExplainResponse {
  const method = req.method?.toUpperCase();
  const releaseMode = req.releaseA !== undefined && req.releaseB !== undefined;
  const last = Math.floor(now / BUCKET_MS);
  const curFirst = last - req.windowMinutes + 1;
  const curFromMs = curFirst * BUCKET_MS;
  const prevFromMs = (curFirst - req.windowMinutes) * BUCKET_MS;

  const before: ExplainSideInput = releaseMode
    ? { label: req.releaseA as string, fromUnixMs: 0, toUnixMs: 0, traces: [] }
    : {
        label: "previous",
        fromUnixMs: prevFromMs,
        toUnixMs: curFromMs,
        traces: [],
      };
  const after: ExplainSideInput = releaseMode
    ? { label: req.releaseB as string, fromUnixMs: 0, toUnixMs: 0, traces: [] }
    : {
        label: "current",
        fromUnixMs: curFromMs,
        toUnixMs: now,
        traces: [],
      };

  const latest = new Map<string, number>();
  let spansSinceTrim = 0;
  try {
    if (!none) {
      store?.scanTraces(
        releaseMode ? 0 : prevFromMs,
        (root, spans, resource, traceId) => {
          if (root.attributes["http.route"] !== req.route) return;
          const m = root.attributes["http.request.method"];
          if (method !== undefined && m !== method) return;
          const release = resource["service.version"];
          const at = root.startTimeUnixMs;
          if (typeof release === "string" && release !== "") {
            if (at >= (latest.get(release) ?? 0)) latest.set(release, at);
          }
          let side: ExplainSideInput | undefined;
          if (releaseMode) {
            if (release === req.releaseA) side = before;
            else if (release === req.releaseB) side = after;
          } else if (at >= curFromMs && at <= now) side = after;
          else if (at >= prevFromMs && at < curFromMs) side = before;
          if (side === undefined) return;
          const code = statusCodeOf(root);
          const trace: ExplainTraceInput = {
            traceId,
            startUnixMs: at,
            durationMs: root.durationMs,
            status: code ?? null,
            error: isErrorSpan(root) || (code !== undefined && code >= 500),
            spans: spans.map(spanInput),
          };
          side.traces.push(trace);
          // Traces arrive oldest first: keep memory bounded to the newest ones.
          if (side.traces.length > 2 * MAX_TRACES_PER_SIDE) {
            side.traces = side.traces.slice(-MAX_TRACES_PER_SIDE);
          }
          // The span cap is checked once the side has grown by half of it again, so the work
          // stays amortised and memory stays under about 1.5 times the cap.
          spansSinceTrim += trace.spans.length;
          if (spansSinceTrim > MAX_SPANS_PER_SIDE / 2) {
            spansSinceTrim = 0;
            trimSpans(side);
          }
        },
      );
    }
  } catch {
    // Answer with what was gathered.
  }
  trimSpans(before);
  trimSpans(after);
  if (releaseMode) {
    for (const side of [before, after]) {
      let first = Number.POSITIVE_INFINITY;
      let lastAt = 0;
      for (const t of side.traces) {
        first = Math.min(first, t.startUnixMs);
        lastAt = Math.max(lastAt, t.startUnixMs);
      }
      side.fromUnixMs = Number.isFinite(first) ? first : 0;
      side.toUnixMs = lastAt;
    }
  }
  const releases = [...latest.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_RELEASES)
    .map(([release]) => release);
  return computeExplain({
    mode: releaseMode ? "release" : "window",
    method: method ?? null,
    route: req.route,
    before,
    after,
    releases,
  });
}
