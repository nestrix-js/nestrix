import type {
  AttributeValue,
  SpanRecord,
  TraceResponse,
} from "@nestrix-js/protocol";
import { fmtMs, fmtPct, oneLine, plural, truncate } from "./format.js";

/** A span is slow when it lasts longer than this, or longer than `SLOW_SHARE` of the trace. */
export const SLOW_MS = 100;
export const SLOW_SHARE = 0.2;
/** The same statement this many times in one trace is called out. */
export const REPEAT_MIN = 3;
/** Spans drawn in the tree, by default. */
export const DEFAULT_MAX_SPANS = 400;

const STATEMENT_KEYS = ["db.query.text", "db.statement"] as const;

/** The SQL (or other statement text) of a span, when it has one. */
export function statementOf(span: SpanRecord): string | undefined {
  for (const key of STATEMENT_KEYS) {
    const value = span.attributes[key];
    if (typeof value === "string" && value !== "") return oneLine(value);
  }
  return undefined;
}

/** The class of a method span: `AuthGuard` of `code.function.name = "AuthGuard.canActivate"`. */
export function classOf(span: SpanRecord): string | undefined {
  const name = span.attributes["code.function.name"];
  if (typeof name !== "string") return undefined;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : undefined;
}

export interface TraceTree {
  spans: SpanRecord[];
  byId: Map<string, SpanRecord>;
  /** Children by parent id, ordered by start time then id. */
  children: Map<string, SpanRecord[]>;
  /** Spans whose parent is not in the trace (a remote parent counts as none). */
  roots: SpanRecord[];
  /** Duration minus the time covered by children, never below 0. */
  selfMs: Map<string, number>;
  /** Duration of the longest root. */
  traceMs: number;
}

function byStart(a: SpanRecord, b: SpanRecord): number {
  return (
    a.startTimeUnixMs - b.startTimeUnixMs ||
    (a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0)
  );
}

/** Builds the span tree and the self time of every span. Parallel children are counted once (union of their intervals). */
export function buildTree(trace: TraceResponse): TraceTree {
  const spans = [...trace.spans].sort(byStart);
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, SpanRecord[]>();
  const roots: SpanRecord[] = [];
  for (const span of spans) {
    const parent = span.parentSpanId;
    if (parent !== undefined && parent !== span.spanId && byId.has(parent)) {
      const list = children.get(parent);
      if (list) list.push(span);
      else children.set(parent, [span]);
    } else {
      roots.push(span);
    }
  }
  const selfMs = new Map<string, number>();
  for (const span of spans) {
    selfMs.set(span.spanId, selfTime(span, children.get(span.spanId) ?? []));
  }
  const traceMs = roots.reduce((max, r) => Math.max(max, r.durationMs), 0);
  return { spans, byId, children, roots, selfMs, traceMs };
}

function selfTime(span: SpanRecord, kids: SpanRecord[]): number {
  if (kids.length === 0) return span.durationMs;
  const from = span.startTimeUnixMs;
  const to = from + span.durationMs;
  const intervals = kids
    .map((k): [number, number] => [
      Math.max(from, k.startTimeUnixMs),
      Math.min(to, k.startTimeUnixMs + k.durationMs),
    ])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [a, b] of intervals) {
    if (Number.isNaN(curStart)) {
      curStart = a;
      curEnd = b;
    } else if (a <= curEnd) {
      curEnd = Math.max(curEnd, b);
    } else {
      covered += curEnd - curStart;
      curStart = a;
      curEnd = b;
    }
  }
  if (!Number.isNaN(curStart)) covered += curEnd - curStart;
  return Math.max(0, span.durationMs - covered);
}

export interface RepeatedStatement {
  statement: string;
  count: number;
  totalMs: number;
  /** Names of the parent spans the calls ran under, sorted. */
  parents: string[];
}

/** Statements that appear at least `min` times, most calls first. */
export function repeatedStatements(
  spans: readonly SpanRecord[],
  byId: ReadonlyMap<string, SpanRecord>,
  min = REPEAT_MIN,
): RepeatedStatement[] {
  const groups = new Map<
    string,
    { count: number; totalMs: number; parents: Set<string> }
  >();
  for (const span of spans) {
    const statement = statementOf(span);
    if (statement === undefined) continue;
    let g = groups.get(statement);
    if (!g) {
      g = { count: 0, totalMs: 0, parents: new Set() };
      groups.set(statement, g);
    }
    g.count++;
    g.totalMs += span.durationMs;
    const parent =
      span.parentSpanId === undefined
        ? undefined
        : byId.get(span.parentSpanId)?.name;
    if (parent !== undefined) g.parents.add(parent);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.count >= min)
    .map(([statement, g]) => ({
      statement,
      count: g.count,
      totalMs: g.totalMs,
      parents: [...g.parents].sort(),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.totalMs - a.totalMs ||
        (a.statement < b.statement ? -1 : 1),
    );
}

export interface SpanError {
  span: SpanRecord;
  type?: string;
  message?: string;
  /** The first stack frames (`at ...` lines), at most 3. */
  frames: string[];
}

/** First `max` frames of a stack trace: its lines that start with `at `. */
export function firstFrames(stack: unknown, max = 3): string[] {
  if (typeof stack !== "string") return [];
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, max)
    .map((l) => truncate(l, 160));
}

function str(value: AttributeValue | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Spans with an error status or an exception event, in start order. */
export function spanErrors(spans: readonly SpanRecord[]): SpanError[] {
  const out: SpanError[] = [];
  for (const span of spans) {
    const event = span.events.find((e) => e.name === "exception");
    if (span.status.code !== "error" && event === undefined) continue;
    const type = str(event?.attributes["exception.type"]);
    const message =
      str(event?.attributes["exception.message"]) ?? span.status.message;
    const error: SpanError = {
      span,
      frames: firstFrames(event?.attributes["exception.stacktrace"]),
    };
    if (type !== undefined) error.type = type;
    if (message !== undefined) error.message = oneLine(message);
    out.push(error);
  }
  return out;
}

/** Attributes worth showing in a tree line; everything else is noise for a reader. */
function keyAttributes(span: SpanRecord, rootService?: string): string[] {
  const a = span.attributes;
  const out: string[] = [];
  const statement = statementOf(span);
  if (statement !== undefined) {
    const system = str(a["db.system.name"]) ?? str(a["db.system"]);
    out.push(`${system ?? "db"}: ${truncate(statement, 120)}`);
  }
  const method = str(a["http.request.method"]);
  const target =
    str(a["url.full"]) ?? str(a["http.route"]) ?? str(a["url.path"]);
  if (method !== undefined && span.kind === "client" && target !== undefined) {
    out.push(`${method} ${truncate(target, 100)}`);
  }
  const status = a["http.response.status_code"];
  if (typeof status === "number") out.push(`status ${status}`);
  const destination = str(a["messaging.destination.name"]);
  if (destination !== undefined) {
    out.push(`${str(a["messaging.system"]) ?? "queue"} ${destination}`);
  }
  if (span.service !== undefined && span.service !== rootService) {
    out.push(`service ${span.service}`);
  }
  return out;
}

export interface RenderTraceOptions {
  maxSpans?: number;
  slowMs?: number;
}

/** A model-friendly rendering of one trace: header, call-outs, then an indented span tree with self times. */
export function renderTrace(
  trace: TraceResponse,
  options: RenderTraceOptions = {},
): string {
  const maxSpans = options.maxSpans ?? DEFAULT_MAX_SPANS;
  const slowMs = options.slowMs ?? SLOW_MS;
  const tree = buildTree(trace);
  const { spans, roots, selfMs, traceMs } = tree;
  const lines: string[] = [];

  if (spans.length === 0) {
    return `Trace ${trace.traceId}: no spans stored.`;
  }
  const root = roots[0] as SpanRecord;
  const rootService = str(trace.resource["service.name"]) ?? root.service;
  const release = str(trace.resource["service.version"]);
  const method = str(root.attributes["http.request.method"]);
  const route = str(root.attributes["http.route"]);
  const statusCode = root.attributes["http.response.status_code"];
  const title = method && route ? `${method} ${route}` : root.name;
  const head = [
    `${title}${typeof statusCode === "number" ? ` -> ${statusCode}` : ""}`,
    fmtMs(traceMs),
    plural(spans.length, "span"),
  ];
  if (rootService) head.push(`service ${rootService}`);
  if (release) head.push(`release ${release}`);
  lines.push(`Trace ${trace.traceId}: ${head.join(", ")}`);
  if (roots.length > 1) {
    lines.push(
      `(${roots.length} root spans: the trace crosses a boundary or lost a parent)`,
    );
  }

  const isSlow = (s: SpanRecord): boolean =>
    !roots.includes(s) &&
    (s.durationMs > slowMs ||
      (traceMs > 0 && s.durationMs > traceMs * SLOW_SHARE));
  const slow = spans.filter(isSlow);
  const errors = spanErrors(spans);
  const repeated = repeatedStatements(spans, tree.byId);

  if (repeated.length > 0) {
    lines.push("", "Repeated statements (possible N+1):");
    for (const r of repeated.slice(0, 5)) {
      const where =
        r.parents.length > 0
          ? ` under ${r.parents.slice(0, 2).join(", ")}`
          : "";
      lines.push(
        `- ${r.count}x ${truncate(r.statement, 160)} (${fmtMs(r.totalMs)} total${where})`,
      );
    }
    if (repeated.length > 5)
      lines.push(`- ... ${repeated.length - 5} more repeated statements`);
  }

  if (errors.length > 0) {
    lines.push("", `Errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) {
      const what =
        [e.type, e.message].filter(Boolean).join(": ") ||
        "error status, no message";
      lines.push(`- ${e.span.name}: ${truncate(what, 240)}`);
      for (const f of e.frames) lines.push(`    ${f}`);
    }
    if (errors.length > 10)
      lines.push(`- ... ${errors.length - 10} more errors`);
  }

  if (slow.length > 0) {
    lines.push(
      "",
      `Slow spans (over ${fmtMs(slowMs)} or over ${trimPct(SLOW_SHARE)} of the trace), longest first:`,
    );
    const ranked = [...slow].sort(
      (a, b) => b.durationMs - a.durationMs || byStart(a, b),
    );
    for (const s of ranked.slice(0, 8)) {
      lines.push(
        `- ${s.name}: ${fmtMs(s.durationMs)} (self ${fmtMs(selfMs.get(s.spanId) ?? 0)}, ${fmtPct(s.durationMs, traceMs)} of trace)`,
      );
    }
    if (ranked.length > 8)
      lines.push(`- ... ${ranked.length - 8} more slow spans`);
  }

  // Which spans to draw: all of them, or when there are too many, flagged and longest first,
  // plus every ancestor so the tree stays connected.
  const shown = new Set<string>();
  const flagged = new Set<string>([
    ...errors.map((e) => e.span.spanId),
    ...slow.map((s) => s.spanId),
  ]);
  if (spans.length <= maxSpans) {
    for (const s of spans) shown.add(s.spanId);
  } else {
    const ranked = [...spans].sort(
      (a, b) =>
        Number(flagged.has(b.spanId)) - Number(flagged.has(a.spanId)) ||
        b.durationMs - a.durationMs ||
        byStart(a, b),
    );
    for (const s of ranked.slice(0, maxSpans)) {
      let cursor: SpanRecord | undefined = s;
      while (cursor && !shown.has(cursor.spanId)) {
        shown.add(cursor.spanId);
        cursor =
          cursor.parentSpanId === undefined
            ? undefined
            : tree.byId.get(cursor.parentSpanId);
      }
    }
  }

  lines.push(
    "",
    "Span tree (duration, self time = duration minus time in child spans):",
  );
  const errorIds = new Set(errors.map((e) => e.span.spanId));
  const draw = (span: SpanRecord, depth: number): void => {
    const flags = [
      errorIds.has(span.spanId) ? "ERROR" : "",
      flagged.has(span.spanId) && !errorIds.has(span.spanId) ? "SLOW" : "",
    ].filter(Boolean);
    const attrs = keyAttributes(span, rootService);
    const self = selfMs.get(span.spanId) ?? 0;
    const selfText =
      (tree.children.get(span.spanId)?.length ?? 0) > 0
        ? ` self ${fmtMs(self)}`
        : "";
    lines.push(
      `${"  ".repeat(depth)}${truncate(oneLine(span.name), 120)} [${span.kind}] ${fmtMs(span.durationMs)}${selfText}${flags.length ? ` <${flags.join(",")}>` : ""}${attrs.length ? ` | ${attrs.join(" | ")}` : ""}`,
    );
    const kids = tree.children.get(span.spanId) ?? [];
    const hidden: SpanRecord[] = [];
    for (const kid of kids) {
      if (shown.has(kid.spanId)) draw(kid, depth + 1);
      else hidden.push(kid);
    }
    if (hidden.length > 0)
      lines.push(`${"  ".repeat(depth + 1)}${hiddenSummary(hidden, tree)}`);
  };
  for (const r of roots) draw(r, 0);
  if (spans.length > maxSpans) {
    lines.push(
      "",
      `Output limited to about ${maxSpans} of ${spans.length} spans: errors, slow spans and the longest others are drawn; hidden ones are summarised per parent.`,
    );
  }
  return lines.join("\n");
}

function trimPct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function hiddenSummary(hidden: SpanRecord[], tree: TraceTree): string {
  const counts = new Map<string, number>();
  let total = 0;
  let size = 0;
  const visit = (s: SpanRecord): void => {
    size++;
    for (const k of tree.children.get(s.spanId) ?? []) visit(k);
  };
  for (const s of hidden) {
    counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
    total += s.durationMs;
    visit(s);
  }
  const names = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([name, n]) => `${truncate(oneLine(name), 60)} x${n}`)
    .join(", ");
  const more =
    size > hidden.length ? ` (${size} spans with their children)` : "";
  return `... ${plural(hidden.length, "span")} not shown${more}, ${fmtMs(total)} total: ${names}`;
}
