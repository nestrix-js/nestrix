import type { ClassStats, MethodStats } from "@nestrix-js/protocol";

export const SORT_KEYS = [
  "name",
  "kind",
  "calls",
  "errors",
  "avg",
  "total",
  "own",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export const DEFAULT_SORT: SortKey = "total";
export const DEFAULT_DIR: SortDir = "desc";

/** The line that turns method spans on; shown when the API says they are off. */
export const ENABLE_LINE =
  "NestFactory.create(AppModule, { instrument: NestrixInstrument })";

/** A method's own time over the window: its per-call estimate times its calls; null without an estimate. */
export function methodOwnMs(m: MethodStats): number | null {
  return m.ownAvgMs === null ? null : m.ownAvgMs * m.calls;
}

/** The class named `name`; every class for none. */
export function filterByClass(
  classes: readonly ClassStats[],
  name: string | null,
): ClassStats[] {
  return name === null
    ? [...classes]
    : classes.filter((c) => c.className === name);
}

interface Row {
  name: string;
  kind: string;
  calls: number;
  errors: number;
  avgMs: number;
  totalMs: number;
  ownMs: number | null;
}

const classRow = (c: ClassStats): Row => ({
  name: c.className,
  kind: c.kind,
  calls: c.calls,
  errors: c.errors,
  avgMs: c.avgMs,
  totalMs: c.totalMs,
  ownMs: c.ownMs,
});

const methodRow = (m: MethodStats): Row => ({
  name: m.method,
  kind: "",
  calls: m.calls,
  errors: m.errors,
  avgMs: m.avgMs,
  totalMs: m.totalMs,
  ownMs: methodOwnMs(m),
});

function value(row: Row, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return row.name;
    case "kind":
      return row.kind;
    case "calls":
      return row.calls;
    case "errors":
      return row.errors;
    case "avg":
      return row.avgMs;
    case "total":
      return row.totalMs;
    case "own":
      return row.ownMs;
  }
}

/** Ascending order on one key; a missing value (null) sorts below any number. */
function compareValues(
  x: string | number | null,
  y: string | number | null,
): number {
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  if (typeof x === "string" && typeof y === "string") return x.localeCompare(y);
  return x < y ? -1 : 1;
}

function sortWith<T>(
  items: readonly T[],
  toRow: (t: T) => Row,
  key: SortKey,
  dir: SortDir,
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const ra = toRow(a);
    const rb = toRow(b);
    const main = compareValues(value(ra, key), value(rb, key));
    // The name tie-break stays ascending whichever way the main key runs.
    return main !== 0 ? sign * main : ra.name.localeCompare(rb.name);
  });
}

export const sortClasses = (
  classes: readonly ClassStats[],
  key: SortKey,
  dir: SortDir,
) => sortWith(classes, classRow, key, dir);

export const sortMethods = (
  methods: readonly MethodStats[],
  key: SortKey,
  dir: SortDir,
) => sortWith(methods, methodRow, key, dir);

/** "-" when there is no estimate (no sampled call of it in the store). */
export function formatOwn(ms: number | null, format: (v: number) => string) {
  return ms === null ? "-" : format(ms);
}
