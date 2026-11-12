import type {
  RouteStats,
  TraceResponse,
  TraceSummary,
} from "@nestrix-js/protocol";
import { fmtMs, fmtPct, oneLine, plural, truncate } from "./format.js";
import {
  buildTree,
  classOf,
  type RepeatedStatement,
  repeatedStatements,
  statementOf,
} from "./trace.js";

export interface ExplainInput {
  route: string;
  method?: string | undefined;
  windowMinutes: number;
  /** Statistics entries of the route (one per method). */
  stats: RouteStats[];
  /** Every stored trace summary of the route that matched, any order. */
  summaries: TraceSummary[];
  /** The slowest of them, in full. */
  traces: TraceResponse[];
  /** Routes that do have statistics, for a hint when `stats` is empty. */
  knownRoutes: string[];
}

interface Bucket {
  name: string;
  selfMs: number;
  calls: number;
  kind?: string;
}

export const EXPLAIN_TRACES = 5;

/** Ranked summary of why a route is slow: statistics, then where the self time of its slowest stored traces goes. */
export function renderExplanation(input: ExplainInput): string {
  const label = input.method ? `${input.method} ${input.route}` : input.route;
  const lines: string[] = [];
  if (input.stats.length === 0) {
    lines.push(
      `No statistics for ${label} in the last ${input.windowMinutes} minutes (no requests, or the route template differs).`,
    );
    if (input.knownRoutes.length > 0) {
      lines.push(
        `Routes with statistics: ${input.knownRoutes.slice(0, 10).join(", ")}${input.knownRoutes.length > 10 ? ", ..." : ""}. The route is the template, for example /users/:id.`,
      );
    }
  } else {
    lines.push(
      `Why is ${label} slow? Last ${input.windowMinutes} minutes, every request counted:`,
    );
    for (const s of [...input.stats].sort((a, b) =>
      a.method < b.method ? -1 : 1,
    )) {
      lines.push(
        `- ${s.method} ${s.route}: ${plural(s.count, "request")}, ${plural(s.errors, "error")}, p50 ${fmtMs(s.p50Ms)}, p95 ${fmtMs(s.p95Ms)}, p99 ${fmtMs(s.p99Ms)}, max ${fmtMs(s.maxMs)}`,
      );
    }
  }

  if (input.traces.length === 0) {
    lines.push(
      "",
      "No stored traces for this route (traces are sampled and kept in memory), so the time cannot be broken down. Statistics above still count every request.",
    );
    return lines.join("\n");
  }

  const trees = input.traces.map((t) => ({ trace: t, tree: buildTree(t) }));
  const bySpan = new Map<string, Bucket>();
  const byClass = new Map<string, Bucket>();
  let totalSelf = 0;
  let totalMs = 0;
  const allRepeated: RepeatedStatement[] = [];
  for (const { tree } of trees) {
    totalMs += tree.traceMs;
    for (const span of tree.spans) {
      const self = tree.selfMs.get(span.spanId) ?? 0;
      totalSelf += self;
      const kind = statementOf(span) !== undefined ? "db" : span.kind;
      const name = oneLine(span.name);
      const key = `${name}\u0000${kind}`;
      const b = bySpan.get(key) ?? { name, selfMs: 0, calls: 0, kind };
      b.selfMs += self;
      b.calls++;
      bySpan.set(key, b);
      const cls = classOf(span);
      if (cls !== undefined) {
        const c = byClass.get(cls) ?? { name: cls, selfMs: 0, calls: 0 };
        c.selfMs += self;
        c.calls++;
        byClass.set(cls, c);
      }
    }
    allRepeated.push(...repeatedStatements(tree.spans, tree.byId));
  }

  const rank = (a: Bucket, b: Bucket): number =>
    b.selfMs - a.selfMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const spanRank = [...bySpan.values()].sort(rank);
  const classRank = [...byClass.values()].sort(rank);

  const durations = input.traces
    .map((t) => fmtMs(buildTree(t).traceMs))
    .join(", ");
  lines.push(
    "",
    `Analysed the ${plural(input.traces.length, "slowest stored trace")} of ${input.summaries.length} for this route (${durations}); ${fmtMs(totalMs)} in total.`,
    "Where the time goes (self time = duration minus time in child spans, summed over those traces):",
  );
  spanRank.slice(0, 8).forEach((b, i) => {
    lines.push(
      `${i + 1}. ${truncate(b.name, 100)} [${b.kind}]: ${fmtMs(b.selfMs)} (${fmtPct(b.selfMs, totalSelf)}) over ${plural(b.calls, "call")}`,
    );
  });
  if (classRank.length > 0) {
    lines.push("", "By class (self time of its method spans):");
    classRank.slice(0, 5).forEach((c, i) => {
      lines.push(
        `${i + 1}. ${c.name}: ${fmtMs(c.selfMs)} (${fmtPct(c.selfMs, totalSelf)}) over ${plural(c.calls, "call")}`,
      );
    });
  }

  const merged = mergeRepeated(allRepeated);
  if (merged.length > 0) {
    lines.push("", "Repeated statements (3 or more times in one trace):");
    for (const r of merged.slice(0, 5)) {
      lines.push(
        `- ${r.count}x ${truncate(r.statement, 160)} (${fmtMs(r.totalMs)} total)`,
      );
    }
  }

  const top = spanRank[0];
  const summary: string[] = [];
  if (top) {
    summary.push(
      `most self time is in "${truncate(top.name, 80)}" (${fmtPct(top.selfMs, totalSelf)})`,
    );
  }
  const firstRepeat = merged[0];
  if (firstRepeat) {
    summary.push(
      `the statement "${truncate(firstRepeat.statement, 80)}" runs ${firstRepeat.count} times (N+1 suspect)`,
    );
  }
  const slowest = input.traces[0];
  if (slowest) {
    lines.push(
      "",
      `Summary: ${summary.join("; ")}. Use get_trace ${slowest.traceId} for the slowest trace in full.`,
    );
  }
  return lines.join("\n");
}

function mergeRepeated(all: RepeatedStatement[]): RepeatedStatement[] {
  const merged = new Map<string, RepeatedStatement>();
  for (const r of all) {
    const m = merged.get(r.statement);
    if (m) {
      m.count += r.count;
      m.totalMs += r.totalMs;
    } else {
      merged.set(r.statement, { ...r });
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.totalMs - a.totalMs ||
      (a.statement < b.statement ? -1 : 1),
  );
}
