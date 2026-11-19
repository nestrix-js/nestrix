// Pure helpers behind every chart's axes, so the uPlot charts and the SVG charts read the same:
// clock times as HH:mm (a date only when the range crosses midnight), few and round gridlines,
// and no "0.00 ms" at the baseline. No React, no uPlot.

const pad = (n: number) => String(n).padStart(2, "0");

/** "09:05": the local clock time of a Unix-ms instant, 24 hours. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Nov 19": the local date of a Unix-ms instant. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() * 10_000 + d.getMonth() * 100 + d.getDate();
};

/** True when the two instants fall on different local days. */
export function crossesDay(fromMs: number, toMs: number): boolean {
  return dayKey(fromMs) !== dayKey(toMs);
}

/**
 * Labels for the ticks of a time axis (uPlot hands them over as Unix seconds). A tick is its
 * clock time; when the range crosses a day, the first tick and every tick that starts a new day
 * carry the date on a second line.
 */
export function timeAxisLabels(
  splitsSeconds: readonly (number | null)[],
  rangeCrossesDay: boolean,
): string[] {
  let previous: number | null = null;
  return splitsSeconds.map((s) => {
    if (s === null) return "";
    const ms = s * 1000;
    const time = hhmm(ms);
    const newDay = previous === null || dayKey(previous) !== dayKey(ms);
    previous = ms;
    return rangeCrossesDay && newDay ? `${time}\n${shortDate(ms)}` : time;
  });
}

/** A y tick: zero is a bare "0" whatever the unit ("0.00 ms", "0.0%", "0 B" all read as "0"). */
export function yTickLabel(
  value: number | null,
  format: (value: number) => string,
): string {
  if (value === null) return "";
  return value === 0 ? "0" : format(value);
}

/**
 * Round gridline values at or below `max`: two to four of them, multiples of the smallest 1, 2 or
 * 5 step that fits four or fewer. `integer` keeps the step a whole number (counts). Empty
 * without a positive maximum.
 */
export function gridTicks(max: number, integer = false): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [];
  const exponent = Math.floor(Math.log10(max));
  let step = max;
  search: for (let e = exponent - 2; e <= exponent; e++) {
    for (const m of [1, 2, 5]) {
      const candidate = m * 10 ** e;
      if (Math.floor(max / candidate + 1e-9) <= 4) {
        step = candidate;
        break search;
      }
    }
  }
  if (integer) step = Math.max(1, Math.ceil(step));
  const ticks: number[] = [];
  for (let v = step; v <= max * (1 + 1e-9); v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

/**
 * Which row of labels each one goes in, so labels that would touch do not. Items are in the
 * order they are placed (`x` is the centre, `width` the label's width, both in pixels); each
 * takes the first row where it stays `gap` clear of the label placed last in that row. When
 * every one of `rows` rows is taken the label goes in the last row.
 */
export function assignLabelRows(
  items: readonly { x: number; width: number }[],
  rows: number,
  gap = 6,
): number[] {
  const rightEdge = new Array<number>(rows).fill(Number.NEGATIVE_INFINITY);
  return items.map((item) => {
    const left = item.x - item.width / 2;
    let row = rows - 1;
    for (let r = 0; r < rows; r++) {
      if (left >= (rightEdge[r] as number) + gap) {
        row = r;
        break;
      }
    }
    rightEdge[row] = Math.max(
      rightEdge[row] as number,
      item.x + item.width / 2,
    );
    return row;
  });
}
