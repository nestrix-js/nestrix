/**
 * `GET api/v1/routes/explain` (phase 12, P12-01): the pure computation behind "why did this route
 * change". Each backend turns the sampled traces of one route into `ExplainTraceInput`s (what it
 * knows how to classify: span kind, statement, method, dependency, exceptions) and calls
 * `computeExplain`. Nothing here reads a store, a clock or a database, and nothing throws.
 *
 * Self-contained on purpose: the standalone server keeps a byte-identical copy of this file
 * (`apps/server/src/query/explain-compute.ts`, checked by a test), so it imports types only.
 *
 * Every figure is per request: the mean over the side's traces. At most the newest
 * {@link MAX_TRACES_PER_SIDE} traces of a side are used, to bound the work; the UI says "from up
 * to 2,000 sampled traces per side".
 */
import type {
  ExplainDependencyRow,
  ExplainErrorRow,
  ExplainFinding,
  ExplainKindRow,
  ExplainMethodRow,
  ExplainSideInfo,
  ExplainStatementRow,
  ExplainTrace,
  RouteExplainResponse,
} from "@nestrix-js/protocol";

/** Traces of one side that are read; the newest ones. */
export const MAX_TRACES_PER_SIDE = 2000;
/** Both sides need this many traces before findings are produced. */
export const MIN_TRACES = 5;
export const MAX_FINDINGS = 8;
export const MAX_ROWS = 20;
export const MAX_SLOWEST = 10;
const MAX_STATEMENT_CHARS = 2000;
const MAX_MESSAGE_CHARS = 300;
const MAX_TITLE_STATEMENT_CHARS = 80;
const MAX_LINK_QUERY_CHARS = 120;

/** Thresholds of the findings, in one place so tests can sit just under and on them. */
export const THRESHOLDS = {
  newStatementMinMs: 5,
  nPlusOneMinCalls: 3,
  nPlusOneFactor: 2,
  slowerStatementCallsTolerance: 0.2,
  slowerStatementFactor: 1.5,
  slowerStatementMinMs: 5,
  slowerDependencyFactor: 1.3,
  slowerDependencyMinMs: 20,
  dependencyErrorsRise: 0.05,
  dependencyErrorsMinFailed: 3,
  slowerMethodFactor: 1.5,
  slowerMethodMinMs: 10,
  newErrorMinTraces: 2,
  moreErrorsFactor: 3,
  moreErrorsMinTraces: 5,
  fasterFall: 0.3,
  fasterMinMs: 10,
  shareMinChangeMs: 10,
  sameRelative: 0.1,
  sameMs: 10,
  errorRateChange: 0.01,
  kindShare: 0.5,
} as const;

type KindKey = ExplainKindRow["key"];
const KIND_KEYS: readonly KindKey[] = [
  "db",
  "http-out",
  "redis",
  "messaging",
  "app",
  "other",
];
const KIND_LABEL: Record<KindKey, string> = {
  db: "database",
  "http-out": "outgoing HTTP",
  redis: "Redis",
  messaging: "messaging",
  app: "application code",
  other: "other",
};

// ---- input -----------------------------------------------------------------------------------

export interface ExplainSpanInput {
  spanId: string;
  parentSpanId?: string;
  durationMs: number;
  /** The span's status is `error`. */
  error: boolean;
  /** The kind its own time is counted under (the overview's `timeKeyOf`). */
  key: KindKey;
  /** A database or cache client span with its statement text (as the Queries page groups). */
  statement?: { statement: string; system: string };
  /** `Class.method` of a method span. */
  method?: string;
  /** The outgoing target (as the Dependencies page names and groups it). */
  dependency?: { name: string; kind: ExplainDependencyRow["kind"] };
  /** `exception` events of the span. */
  exceptions: { type?: string; message?: string }[];
}

export interface ExplainTraceInput {
  traceId: string;
  startUnixMs: number;
  durationMs: number;
  /** HTTP status of the root. */
  status: number | null;
  /** The root failed: status code `error` or an HTTP status of 500 and above. */
  error: boolean;
  spans: ExplainSpanInput[];
}

export interface ExplainSideInput {
  label: string;
  fromUnixMs: number;
  toUnixMs: number;
  traces: ExplainTraceInput[];
}

export interface ExplainInput {
  mode: "window" | "release";
  method: string | null;
  route: string;
  before: ExplainSideInput;
  after: ExplainSideInput;
  releases: string[];
}

// ---- formatting ------------------------------------------------------------------------------

/** Milliseconds below one second, then seconds with one decimal (as the UI and the overview do). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const signedMs = (ms: number): string =>
  `${ms < 0 ? "-" : "+"}${formatMs(Math.abs(ms))}`;

const calls1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

const pct = (r: number): string => `${Math.round(r * 1000) / 10}%`;

const cut = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A statement for a title: one line, at most 80 characters. */
const titleStatement = (s: string): string =>
  cut(oneLine(s), MAX_TITLE_STATEMENT_CHARS);

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

// ---- one side --------------------------------------------------------------------------------

interface Agg {
  calls: number;
  ms: number;
  failed: number;
}

interface SideData {
  info: ExplainSideInfo;
  traces: ExplainTraceInput[];
  n: number;
  kinds: Record<KindKey, number>;
  statements: Map<string, Agg & { statement: string; system: string }>;
  methods: Map<string, Agg>;
  dependencies: Map<string, Agg & { name: string; kind: string }>;
  errors: Map<string, { traces: number; message: string }>;
}

const newKinds = (): Record<KindKey, number> => ({
  db: 0,
  "http-out": 0,
  redis: 0,
  messaging: 0,
  app: 0,
  other: 0,
});

/** Own time per span (duration minus its direct children's, at least 0), by span id. */
function ownTimes(spans: readonly ExplainSpanInput[]): Map<string, number> {
  const children = new Map<string, number>();
  for (const s of spans) {
    if (s.parentSpanId === undefined) continue;
    children.set(
      s.parentSpanId,
      (children.get(s.parentSpanId) ?? 0) + finite(s.durationMs),
    );
  }
  const own = new Map<string, number>();
  for (const s of spans) {
    own.set(
      s.spanId,
      Math.max(0, finite(s.durationMs) - (children.get(s.spanId) ?? 0)),
    );
  }
  return own;
}

const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

function bump<T extends Agg>(map: Map<string, T>, key: string, make: () => T) {
  let a = map.get(key);
  if (a === undefined) {
    a = make();
    map.set(key, a);
  }
  return a;
}

function sideData(input: ExplainSideInput): SideData {
  // The newest traces only.
  const traces = (
    input.traces.length > MAX_TRACES_PER_SIDE
      ? input.traces
          .slice()
          .sort((a, b) => b.startUnixMs - a.startUnixMs)
          .slice(0, MAX_TRACES_PER_SIDE)
      : input.traces
  ).slice();
  const data: SideData = {
    info: {
      label: input.label,
      fromUnixMs: input.fromUnixMs,
      toUnixMs: input.toUnixMs,
      traces: traces.length,
      meanMs: 0,
      p95Ms: 0,
      errorRate: 0,
    },
    traces,
    n: traces.length,
    kinds: newKinds(),
    statements: new Map(),
    methods: new Map(),
    dependencies: new Map(),
    errors: new Map(),
  };
  if (traces.length === 0) return data;

  const durations: number[] = [];
  let sum = 0;
  let failed = 0;
  for (const t of traces) {
    const d = finite(t.durationMs);
    durations.push(d);
    sum += d;
    if (t.error) failed++;
    const own = ownTimes(t.spans);
    const seenErrors = new Set<string>();
    for (const s of t.spans) {
      const ownMs = own.get(s.spanId) ?? 0;
      data.kinds[s.key] += ownMs;
      const ms = finite(s.durationMs);
      if (s.statement !== undefined) {
        const key = `${s.statement.system}\u0000${s.statement.statement}`;
        const a = bump(data.statements, key, () => ({
          calls: 0,
          ms: 0,
          failed: 0,
          statement: cut(s.statement?.statement ?? "", MAX_STATEMENT_CHARS),
          system: s.statement?.system ?? "",
        }));
        a.calls++;
        a.ms += ms;
        if (s.error) a.failed++;
      }
      if (s.method !== undefined) {
        const a = bump(data.methods, s.method, () => ({
          calls: 0,
          ms: 0,
          failed: 0,
        }));
        a.calls++;
        a.ms += ownMs;
        if (s.error) a.failed++;
      }
      if (s.dependency !== undefined) {
        const key = `${s.dependency.kind}\u0000${s.dependency.name}`;
        const a = bump(data.dependencies, key, () => ({
          calls: 0,
          ms: 0,
          failed: 0,
          name: s.dependency?.name ?? "",
          kind: s.dependency?.kind ?? "",
        }));
        a.calls++;
        a.ms += ms;
        if (s.error) a.failed++;
      }
      for (const e of s.exceptions) {
        const type =
          typeof e.type === "string" && e.type !== "" ? e.type : "Error";
        let row = data.errors.get(type);
        if (row === undefined) {
          row = {
            traces: 0,
            message: cut(
              typeof e.message === "string" ? e.message : "",
              MAX_MESSAGE_CHARS,
            ),
          };
          data.errors.set(type, row);
        }
        if (!seenErrors.has(type)) {
          seenErrors.add(type);
          row.traces++;
        }
      }
    }
  }
  durations.sort((a, b) => a - b);
  data.info.meanMs = round3(sum / traces.length);
  data.info.p95Ms = round3(quantile(durations, 0.95));
  data.info.errorRate = failed / traces.length;
  return data;
}

// ---- rows ------------------------------------------------------------------------------------

const per = (total: number, n: number): number => (n === 0 ? 0 : total / n);

interface Rows {
  kinds: ExplainKindRow[];
  statements: ExplainStatementRow[];
  methods: ExplainMethodRow[];
  dependencies: ExplainDependencyRow[];
  errors: ExplainErrorRow[];
}

const byChange = <T extends { beforeMs: number; afterMs: number }>(
  a: T,
  b: T,
): number =>
  Math.abs(b.afterMs - b.beforeMs) - Math.abs(a.afterMs - a.beforeMs) ||
  b.afterMs - a.afterMs;

function buildRows(before: SideData, after: SideData): Rows {
  const kinds = KIND_KEYS.map((key) => ({
    key,
    beforeMs: round3(per(before.kinds[key], before.n)),
    afterMs: round3(per(after.kinds[key], after.n)),
  }));

  const statements: ExplainStatementRow[] = [];
  for (const key of new Set([
    ...before.statements.keys(),
    ...after.statements.keys(),
  ])) {
    const b = before.statements.get(key);
    const a = after.statements.get(key);
    const ref = (a ?? b) as NonNullable<typeof a>;
    statements.push({
      statement: ref.statement,
      system: ref.system,
      beforeCalls: round3(per(b?.calls ?? 0, before.n)),
      afterCalls: round3(per(a?.calls ?? 0, after.n)),
      beforeMs: round3(per(b?.ms ?? 0, before.n)),
      afterMs: round3(per(a?.ms ?? 0, after.n)),
      beforeEachMs: b === undefined ? null : round3(b.ms / b.calls),
      afterEachMs: a === undefined ? null : round3(a.ms / a.calls),
    });
  }

  const methods: ExplainMethodRow[] = [];
  for (const name of new Set([
    ...before.methods.keys(),
    ...after.methods.keys(),
  ])) {
    const b = before.methods.get(name);
    const a = after.methods.get(name);
    methods.push({
      name,
      beforeCalls: round3(per(b?.calls ?? 0, before.n)),
      afterCalls: round3(per(a?.calls ?? 0, after.n)),
      beforeMs: round3(per(b?.ms ?? 0, before.n)),
      afterMs: round3(per(a?.ms ?? 0, after.n)),
    });
  }

  const dependencies: ExplainDependencyRow[] = [];
  for (const key of new Set([
    ...before.dependencies.keys(),
    ...after.dependencies.keys(),
  ])) {
    const b = before.dependencies.get(key);
    const a = after.dependencies.get(key);
    const ref = (a ?? b) as NonNullable<typeof a>;
    dependencies.push({
      name: ref.name,
      kind: ref.kind as ExplainDependencyRow["kind"],
      beforeCalls: round3(per(b?.calls ?? 0, before.n)),
      afterCalls: round3(per(a?.calls ?? 0, after.n)),
      beforeMs: round3(per(b?.ms ?? 0, before.n)),
      afterMs: round3(per(a?.ms ?? 0, after.n)),
      beforeErrorRate: b === undefined ? null : b.failed / b.calls,
      afterErrorRate: a === undefined ? null : a.failed / a.calls,
    });
  }

  const errors: ExplainErrorRow[] = [];
  for (const type of new Set([
    ...before.errors.keys(),
    ...after.errors.keys(),
  ])) {
    const b = before.errors.get(type);
    const a = after.errors.get(type);
    errors.push({
      type,
      message: (a ?? b)?.message ?? "",
      beforeTraces: b?.traces ?? 0,
      afterTraces: a?.traces ?? 0,
    });
  }

  statements.sort(byChange);
  methods.sort(byChange);
  dependencies.sort(byChange);
  errors.sort(
    (x, y) =>
      y.afterTraces - x.afterTraces ||
      y.beforeTraces - x.beforeTraces ||
      (x.type < y.type ? -1 : x.type > y.type ? 1 : 0),
  );
  return {
    kinds,
    statements: statements.slice(0, MAX_ROWS),
    methods: methods.slice(0, MAX_ROWS),
    dependencies: dependencies.slice(0, MAX_ROWS),
    errors: errors.slice(0, MAX_ROWS),
  };
}

// ---- findings --------------------------------------------------------------------------------

/** A finding with what the summary and the sort need. */
interface Candidate {
  finding: ExplainFinding;
  /** Words for "mainly <short>" in the summary. */
  short: string;
  group: "timing" | "error" | "better";
}

/** The total behind one row, kept unrounded where a rule needs an absolute count. */
function failedCalls(side: SideData, key: string): number {
  return side.dependencies.get(key)?.failed ?? 0;
}

function share(deltaMs: number, change: number): number | null {
  if (Math.abs(change) < THRESHOLDS.shareMinChangeMs) return null;
  return Math.min(1, Math.max(0, deltaMs / change));
}

const timesPhrase = (calls: number): string =>
  calls1(calls) === "1.0" ? "once" : `${calls1(calls)} times`;

function statementCandidates(
  rows: readonly ExplainStatementRow[],
  change: number,
): Candidate[] {
  const out: Candidate[] = [];
  const T = THRESHOLDS;
  for (const r of rows) {
    const delta = r.afterMs - r.beforeMs;
    const text = titleStatement(r.statement);
    const link = {
      view: "queries" as const,
      params: { q: cut(oneLine(r.statement), MAX_LINK_QUERY_CHARS) },
    };
    const nPlusOne =
      r.afterCalls >= T.nPlusOneMinCalls &&
      (r.beforeCalls === 0 || r.afterCalls >= T.nPlusOneFactor * r.beforeCalls);
    if (nPlusOne) {
      const intro =
        r.beforeCalls === 0
          ? `A new statement runs ${timesPhrase(r.afterCalls)} per request`
          : `A statement runs ${timesPhrase(r.afterCalls)} per request, was ${calls1(r.beforeCalls)}`;
      out.push({
        group: "timing",
        short:
          r.beforeCalls === 0
            ? "one new statement run many times"
            : "a statement that runs far more often",
        finding: {
          kind: "n-plus-one",
          direction: "worse",
          title: `${intro} (${text}), adding ${formatMs(delta)}.`,
          deltaMs: round3(delta),
          shareOfChange: share(delta, change),
          link,
        },
      });
      continue;
    }
    if (
      r.beforeCalls === 0 &&
      r.afterCalls >= 1 &&
      r.afterMs >= T.newStatementMinMs
    ) {
      out.push({
        group: "timing",
        short: "one new statement",
        finding: {
          kind: "new-statement",
          direction: "worse",
          title: `A new statement runs ${timesPhrase(r.afterCalls)} per request (${text}), adding ${formatMs(delta)}.`,
          deltaMs: round3(delta),
          shareOfChange: share(delta, change),
          link,
        },
      });
      continue;
    }
    if (
      r.beforeCalls > 0 &&
      r.beforeEachMs !== null &&
      r.afterEachMs !== null &&
      Math.abs(r.afterCalls - r.beforeCalls) <=
        T.slowerStatementCallsTolerance * r.beforeCalls &&
      r.afterEachMs >= T.slowerStatementFactor * r.beforeEachMs &&
      delta >= T.slowerStatementMinMs
    ) {
      out.push({
        group: "timing",
        short: "a slower statement",
        finding: {
          kind: "slower-statement",
          direction: "worse",
          title: `A statement now takes ${formatMs(r.afterEachMs)} per run, was ${formatMs(r.beforeEachMs)} (${text}), adding ${formatMs(delta)} per request.`,
          deltaMs: round3(delta),
          shareOfChange: share(delta, change),
          link,
        },
      });
      continue;
    }
    if (fell(r.beforeMs, r.afterMs)) {
      out.push({
        group: "better",
        short: "a faster statement",
        finding: {
          kind: "faster",
          direction: "better",
          title: `A statement takes ${formatMs(r.afterMs)} per request, was ${formatMs(r.beforeMs)} (${text}).`,
          deltaMs: round3(delta),
          shareOfChange: share(delta, change),
          link,
        },
      });
    }
  }
  return out;
}

/** Time per request fell by at least 30% and at least 10 ms. */
function fell(beforeMs: number, afterMs: number): boolean {
  return (
    beforeMs - afterMs >= THRESHOLDS.fasterMinMs &&
    afterMs <= (1 - THRESHOLDS.fasterFall) * beforeMs
  );
}

function dependencyCandidates(
  rows: readonly ExplainDependencyRow[],
  after: SideData,
  change: number,
): Candidate[] {
  const out: Candidate[] = [];
  const T = THRESHOLDS;
  for (const r of rows) {
    const delta = r.afterMs - r.beforeMs;
    const link = {
      view: "dependencies" as const,
      params: { name: r.name },
    };
    let slower = false;
    if (
      r.afterMs >= T.slowerDependencyFactor * r.beforeMs &&
      delta >= T.slowerDependencyMinMs
    ) {
      slower = true;
      out.push({
        group: "timing",
        short: `slower calls to ${r.name}`,
        finding: {
          kind: "slower-dependency",
          direction: "worse",
          title:
            r.beforeCalls === 0
              ? `${r.name} is new: ${formatMs(r.afterMs)} per request.`
              : `${r.name} takes ${formatMs(r.afterMs)} per request, was ${formatMs(r.beforeMs)}.`,
          deltaMs: round3(delta),
          shareOfChange: share(delta, change),
          link,
        },
      });
    }
    const key = `${r.kind}\u0000${r.name}`;
    const afterFailed = failedCalls(after, key);
    const beforeRate = r.beforeErrorRate ?? 0;
    if (
      r.afterErrorRate !== null &&
      r.afterErrorRate - beforeRate >= T.dependencyErrorsRise &&
      afterFailed >= T.dependencyErrorsMinFailed
    ) {
      out.push({
        group: "error",
        short: `failing calls to ${r.name}`,
        finding: {
          kind: "dependency-errors",
          direction: "worse",
          title: `${r.name} failed ${pct(r.afterErrorRate)} of calls, was ${pct(beforeRate)}.`,
          deltaMs: null,
          shareOfChange: null,
          link,
        },
      });
    }
    if (!slower && fell(r.beforeMs, r.afterMs)) {
      out.push({
        group: "better",
        short: `faster calls to ${r.name}`,
        finding: {
          kind: "faster",
          direction: "better",
          title: `${r.name} takes ${formatMs(r.afterMs)} per request, was ${formatMs(r.beforeMs)}.`,
          deltaMs: round3(delta),
          shareOfChange: share(delta, change),
          link,
        },
      });
    }
  }
  return out;
}

function methodCandidates(
  rows: readonly ExplainMethodRow[],
  change: number,
): Candidate[] {
  const out: Candidate[] = [];
  const T = THRESHOLDS;
  for (const r of rows) {
    const delta = r.afterMs - r.beforeMs;
    const link = {
      view: "classes" as const,
      params: { class: r.name.split(".")[0] ?? r.name },
    };
    if (
      r.afterMs >= T.slowerMethodFactor * r.beforeMs &&
      delta >= T.slowerMethodMinMs
    ) {
      out.push({
        group: "timing",
        short: `slower ${r.name}`,
        finding: {
          kind: "slower-method",
          direction: "worse",
          title:
            r.beforeCalls === 0
              ? `${r.name} is new and takes ${formatMs(r.afterMs)} per request.`
              : `${r.name} takes ${formatMs(r.afterMs)} per request, was ${formatMs(r.beforeMs)}.`,
          deltaMs: round3(delta),
          shareOfChange: share(delta, change),
          link,
        },
      });
    } else if (fell(r.beforeMs, r.afterMs)) {
      out.push({
        group: "better",
        short: `faster ${r.name}`,
        finding: {
          kind: "faster",
          direction: "better",
          title: `${r.name} takes ${formatMs(r.afterMs)} per request, was ${formatMs(r.beforeMs)}.`,
          deltaMs: round3(delta),
          shareOfChange: share(delta, change),
          link,
        },
      });
    }
  }
  return out;
}

function errorCandidates(
  rows: readonly ExplainErrorRow[],
  route: string,
): Candidate[] {
  const out: Candidate[] = [];
  const T = THRESHOLDS;
  for (const r of rows) {
    const link = {
      view: "errors" as const,
      params: { route, type: r.type },
    };
    if (r.beforeTraces === 0 && r.afterTraces >= T.newErrorMinTraces) {
      out.push({
        group: "error",
        short: `new ${r.type}`,
        finding: {
          kind: "new-error",
          direction: "worse",
          title: `${r.type} is new: ${r.afterTraces} traces.`,
          deltaMs: null,
          shareOfChange: null,
          link,
        },
      });
    } else if (
      r.beforeTraces > 0 &&
      r.afterTraces >= T.moreErrorsFactor * r.beforeTraces &&
      r.afterTraces >= T.moreErrorsMinTraces
    ) {
      out.push({
        group: "error",
        short: `more ${r.type}`,
        finding: {
          kind: "more-errors",
          direction: "worse",
          title: `${r.type} is in ${r.afterTraces} traces, was ${r.beforeTraces}.`,
          deltaMs: null,
          shareOfChange: null,
          link,
        },
      });
    }
  }
  return out;
}

const GROUP_ORDER = { timing: 0, error: 1, better: 2 } as const;

/** Every finding that fires, ranked, before the cap. */
function findCandidates(
  rows: Rows,
  before: SideData,
  after: SideData,
  route: string,
): Candidate[] {
  const change = after.info.meanMs - before.info.meanMs;
  const all = [
    ...statementCandidates(rows.statements, change),
    ...dependencyCandidates(rows.dependencies, after, change),
    ...methodCandidates(rows.methods, change),
    ...errorCandidates(rows.errors, route),
  ];
  // Stable within a group: worse timing by deltaMs, better by |deltaMs|; errors keep their order.
  return all
    .map((c, i) => ({ c, i }))
    .sort(
      (x, y) =>
        GROUP_ORDER[x.c.group] - GROUP_ORDER[y.c.group] ||
        (x.c.group === "error"
          ? 0
          : Math.abs(y.c.finding.deltaMs ?? 0) -
            Math.abs(x.c.finding.deltaMs ?? 0)) ||
        x.i - y.i,
    )
    .map((x) => x.c);
}

// ---- summary ---------------------------------------------------------------------------------

function summaryOf(
  before: SideData,
  after: SideData,
  kinds: readonly ExplainKindRow[],
  ranked: readonly Candidate[],
): string {
  const T = THRESHOLDS;
  const x = before.info.meanMs;
  const y = after.info.meanMs;
  const diff = y - x;
  const same = Math.abs(diff) < T.sameRelative * x && Math.abs(diff) < T.sameMs;
  const errorsMoved =
    Math.abs(after.info.errorRate - before.info.errorRate) >= T.errorRateChange;
  if (same) {
    return errorsMoved
      ? `Errors went from ${pct(before.info.errorRate)} to ${pct(after.info.errorRate)}.`
      : `Mean time is about the same (${formatMs(x)} → ${formatMs(y)}).`;
  }
  let text = `Mean time went from ${formatMs(x)} to ${formatMs(y)}`;
  const top = kinds
    .map((k) => ({ key: k.key, delta: k.afterMs - k.beforeMs }))
    .filter((k) => Math.sign(k.delta) === Math.sign(diff))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  if (
    top !== undefined &&
    Math.abs(top.delta) >= T.kindShare * Math.abs(diff)
  ) {
    text += `; most of it is ${KIND_LABEL[top.key]} time (${signedMs(top.delta)})`;
  }
  const direction = diff > 0 ? "worse" : "better";
  const lead = ranked.find((c) => c.finding.direction === direction);
  if (lead !== undefined) text += `, mainly ${lead.short}`;
  return `${text}.`;
}

// ---- traces ----------------------------------------------------------------------------------

function slowestOf(after: SideData): ExplainTrace[] {
  return after.traces
    .slice()
    .sort(
      (a, b) =>
        b.durationMs - a.durationMs ||
        b.startUnixMs - a.startUnixMs ||
        (a.traceId < b.traceId ? -1 : 1),
    )
    .slice(0, MAX_SLOWEST)
    .map((t) => {
      const own = ownTimes(t.spans);
      const kinds = newKinds();
      for (const s of t.spans) kinds[s.key] += own.get(s.spanId) ?? 0;
      const total = KIND_KEYS.reduce((n, k) => n + kinds[k], 0);
      const duration = finite(t.durationMs);
      // Parallel children can make the sum exceed the duration: scale to fit.
      const scale = total > duration && total > 0 ? duration / total : 1;
      return {
        traceId: t.traceId,
        startUnixMs: t.startUnixMs,
        durationMs: round3(duration),
        status: t.status,
        error: t.error,
        byKind: KIND_KEYS.filter((k) => kinds[k] > 0).map((key) => ({
          key,
          ms: round3(kinds[key] * scale),
        })),
      };
    });
}

// ---- entry -----------------------------------------------------------------------------------

export function computeExplain(input: ExplainInput): RouteExplainResponse {
  const before = sideData(input.before);
  const after = sideData(input.after);
  const rows = buildRows(before, after);
  const enough = before.n >= MIN_TRACES && after.n >= MIN_TRACES;
  const ranked = enough ? findCandidates(rows, before, after, input.route) : [];
  return {
    mode: input.mode,
    method: input.method,
    route: input.route,
    before: before.info,
    after: after.info,
    releases: input.releases,
    findings: ranked.slice(0, MAX_FINDINGS).map((c) => c.finding),
    summary: enough
      ? summaryOf(before, after, rows.kinds, ranked)
      : `Not enough traces to compare (${before.n} before, ${after.n} after).`,
    kinds: rows.kinds,
    statements: rows.statements,
    methods: rows.methods,
    dependencies: rows.dependencies,
    errors: rows.errors,
    slowest: slowestOf(after),
  };
}
