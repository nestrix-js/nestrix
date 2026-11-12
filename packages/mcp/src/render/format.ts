/** Small formatting helpers shared by the renderers. All output is deterministic: no locale, no time zone. */

/** Milliseconds as `0.42ms`, `12.3ms`, `182ms` or `1.25s`. */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const abs = Math.abs(ms);
  if (abs >= 1000) return `${trimZeros((ms / 1000).toFixed(2))}s`;
  if (abs >= 100) return `${Math.round(ms)}ms`;
  if (abs >= 10) return `${trimZeros(ms.toFixed(1))}ms`;
  return `${trimZeros(ms.toFixed(2))}ms`;
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** `12.3%`; `0%` when the whole is 0. */
export function fmtPct(part: number, whole: number): string {
  if (!(whole > 0)) return "0%";
  return `${trimZeros(((part / whole) * 100).toFixed(1))}%`;
}

/** Unix ms as `2026-11-12T10:15:30Z`. */
export function fmtTime(unixMs: number): string {
  const date = new Date(unixMs);
  if (Number.isNaN(date.getTime())) return "?";
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Collapses whitespace runs (including newlines) to one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most `max` characters, ending in `…` when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** For any string that came from telemetry: one line, at most `max` characters. */
export function clean(text: string, max: number): string {
  return truncate(oneLine(text), max);
}

/** Pads every cell but the last of each row to its column's width. */
export function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) =>
        i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
