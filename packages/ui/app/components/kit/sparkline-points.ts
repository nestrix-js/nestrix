/**
 * The points of a sparkline: `values` spread over `width`, scaled to `height` (0 at the bottom,
 * the maximum at the top, with `pad` of room at both ends). One value is a flat line across the
 * width; no values give no points. The scale starts at 0, so a flat series reads as flat.
 */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  pad = 2,
): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 0);
  const usable = height - pad * 2;
  const y = (v: number) =>
    max === 0 ? height - pad : height - pad - (v / max) * usable;
  const step =
    values.length === 1 ? 0 : (width - pad * 2) / (values.length - 1);
  return values
    .map((v, i) => {
      const x = values.length === 1 ? pad : pad + i * step;
      return `${x.toFixed(1)},${y(v).toFixed(1)}`;
    })
    .join(" ");
}
