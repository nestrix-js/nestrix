// Pure helpers behind the kit's components, kept apart so they can be unit tested.

/** Whether a change is good news (`better`), bad news (`worse`) or neither. */
export type Tone = "worse" | "better" | "neutral";

/** Chip colours: the three tones, `info` for facts, `warn` for caution (a 4xx, a slow call). */
export type ChipTone = Tone | "info" | "warn";

export interface DonutSlice {
  key: string;
  /** The raw value this slice stands for. */
  value: number;
  /** A CSS custom property, e.g. `--chart-1`. */
  color: string;
  /** `value` over the sum, 0 to 1. */
  fraction: number;
  /** SVG `stroke-dasharray` and `stroke-dashoffset` of a circle of `radius` that draws the slice. */
  dasharray: string;
  dashoffset: number;
}

/**
 * Slices of a donut drawn as arcs of one circle (`stroke-dasharray`): each slice starts where the
 * last ended, from the top. Slices with no value are left out. A tiny slice is kept at least
 * `minArc` long (in circumference units) so it stays visible.
 */
export function donutSlices(
  items: readonly { key: string; value: number; color: string }[],
  radius: number,
  minArc = 1.5,
): DonutSlice[] {
  const positive = items.filter((i) => i.value > 0);
  const total = positive.reduce((sum, i) => sum + i.value, 0);
  if (total <= 0) return [];
  const circumference = 2 * Math.PI * radius;
  let start = 0;
  return positive.map((item) => {
    const fraction = item.value / total;
    const length = Math.max(minArc, fraction * circumference);
    const slice: DonutSlice = {
      key: item.key,
      value: item.value,
      color: item.color,
      fraction,
      dasharray: `${length.toFixed(2)} ${(circumference - length).toFixed(2)}`,
      dashoffset: -start,
    };
    start += fraction * circumference;
    return slice;
  });
}

/** `stroke-dasharray` of a ring that is `fraction` full (0 to 1, clamped). */
export function ringDasharray(fraction: number, radius: number): string {
  const circumference = 2 * Math.PI * radius;
  const filled = Math.min(1, Math.max(0, fraction)) * circumference;
  return `${filled.toFixed(2)} ${(circumference - filled).toFixed(2)}`;
}

/** `value` as a share of `max` in percent, clamped to 0 to 100; 0 without a positive maximum. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.min(Math.max((value / max) * 100, 0), 100);
}

/** The next "round" number at or above `value` (1, 2, 5 times a power of ten); 1 for no value. */
export function niceMax(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return step * base;
}

/** The sign of every negative number and change the dashboard writes: a minus, not a hyphen. */
export const MINUS = "−";

/**
 * A magnitude with two significant digits: one decimal below 10 ("4.2"), whole from 10 up
 * ("12"). Rounding that reaches 10 ("9.96") gives "10", never "10.0". The sign is dropped.
 */
export function twoDigits(value: number): string {
  const abs = Math.abs(value);
  const tenths = Number(abs.toFixed(1));
  return tenths < 10 ? tenths.toFixed(1) : String(Math.round(abs));
}

/**
 * `value` with an explicit sign and the magnitude written by `format` ("+12%", "−3.4 ms"). A
 * value that `format` writes as zero has no sign: `zero` ("0%").
 */
export function withSign(
  value: number,
  format: (magnitude: number) => string,
  zero: string,
): string {
  if (Number(twoDigits(value)) === 0) return zero;
  return `${value > 0 ? "+" : MINUS}${format(Math.abs(value))}`;
}

/**
 * "0 ms", "<0.1 ms", "4.2 ms", "38 ms", "1.5 s", "12 s", "2.0 min": one rule for every duration,
 * two significant digits and a unit that follows the rounded value (999.7 ms is "1.0 s"). A
 * negative duration (a difference) gets a true minus; anything not finite is "-".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 0) return `${MINUS}${formatDuration(-ms)}`;
  if (ms === 0) return "0 ms";
  if (ms < 0.05) return "<0.1 ms";
  const asMs = twoDigits(ms);
  if (Number(asMs) < 1000) return `${asMs} ms`;
  const asSeconds = twoDigits(ms / 1000);
  if (Number(asSeconds) < 60) return `${asSeconds} s`;
  return `${twoDigits(ms / 60_000)} min`;
}

/**
 * "0%", "<0.1%", "7.8%", "12%", "100%": a share given in percent, two significant digits, no
 * space before the sign. Negative values (an overspent budget) get a true minus; anything not
 * finite is "-".
 */
export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return "-";
  if (percent < 0) return `${MINUS}${formatPercent(-percent)}`;
  if (percent === 0) return "0%";
  if (percent < 0.05) return "<0.1%";
  // Rounding must not claim a whole 100% for a share that is not (99.6% is not "100%"); from
  // 99.95 the one decimal rounds to 100 itself.
  if (percent < 99.95 && Number(twoDigits(percent)) >= 100)
    return `${(Math.floor(percent * 10) / 10).toFixed(1)}%`;
  return `${twoDigits(percent)}%`;
}

/** `formatPercent` of a fraction: 0.078 is "7.8%". */
export function formatFraction(fraction: number): string {
  return formatPercent(fraction * 100);
}

/** "950", "1.2k", "34k", "2.5M": a count short enough for an axis or a tile. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const trim = (n: number) =>
    (n < 10 ? n.toFixed(1) : String(Math.round(n))).replace(/\.0$/, "");
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value));
}

export interface StackSegment {
  value: number;
  /** A CSS custom property, e.g. `--chart-1`; `--chart-1` when absent. Red or green only for bad or good. */
  color?: string;
  label?: string;
  /** 0 to 1; a softer fill for the "normal" part under a stronger "problem" part. */
  opacity?: number;
}

/**
 * The segments of one stacked bar as percentages of `max` (the scale of the whole chart), in
 * order from the base. Segments with no value are dropped; a total above `max` is scaled to fit.
 */
export function stackHeights(
  segments: readonly StackSegment[],
  max: number,
): (StackSegment & { percent: number })[] {
  const positive = segments.filter((s) => s.value > 0);
  const total = positive.reduce((sum, s) => sum + s.value, 0);
  const scale = Math.max(max, total);
  return positive.map((s) => ({
    ...s,
    percent: scale > 0 ? (s.value / scale) * 100 : 0,
  }));
}

/** A heatmap cell's intensity step: 0 for no value, else 1 to `steps` in proportion to `max`. */
export function heatLevel(value: number, max: number, steps = 5): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(steps, Math.max(1, Math.ceil((value / max) * steps)));
}

/** The CSS opacity for a heat level: a clear step between levels, never fully transparent. */
export function heatOpacity(level: number, steps = 5): number {
  if (level <= 0) return 0;
  return 0.18 + (0.82 * Math.min(level, steps)) / steps;
}

/** The size of the SVG coordinate space the area chart draws in. */
export const CHART_W = 860;
export const CHART_H = 220;

const point = (
  values: readonly (number | null)[],
  i: number,
  max: number,
): [string, string] => {
  const step = values.length > 1 ? CHART_W / (values.length - 1) : 0;
  const x = (values.length > 1 ? i * step : CHART_W / 2).toFixed(1);
  const y = (CHART_H - 4 - ((values[i] ?? 0) / max) * (CHART_H - 12)).toFixed(
    1,
  );
  return [x, y];
};

/** `values` as `M`/`L` path commands in chart space; a `null` ends the segment (a gap). */
export function linePath(
  values: readonly (number | null)[],
  max: number,
): string {
  let d = "";
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    const [x, y] = point(values, i, max);
    d += `${open ? "L" : "M"}${x} ${y} `;
    open = true;
  });
  return d.trim();
}

/** A closed path from `values` down to the baseline, one per unbroken run; "" when nothing is drawn. */
export function areaPath(
  values: readonly (number | null)[],
  max: number,
): string {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length > 0) runs.push(run);
  return runs
    .map((indexes) => {
      const first = indexes[0] as number;
      const last = indexes[indexes.length - 1] as number;
      const top = indexes.map((i, n) => {
        const [x, y] = point(values, i, max);
        return `${n === 0 ? "M" : "L"}${x} ${y}`;
      });
      const [x0] = point(values, first, max);
      const [x1] = point(values, last, max);
      return `${top.join(" ")} L${x1} ${CHART_H} L${x0} ${CHART_H} Z`;
    })
    .join(" ");
}

/** Running totals across series, index by index (a `null` counts as 0), for stacked areas. */
export function cumulativeSeries(
  series: readonly (readonly (number | null)[])[],
): number[][] {
  const length = Math.max(0, ...series.map((s) => s.length));
  const totals = new Array<number>(length).fill(0);
  return series.map((values) => {
    for (let i = 0; i < length; i++)
      totals[i] = (totals[i] ?? 0) + (values[i] ?? 0);
    return [...totals];
  });
}
