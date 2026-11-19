// Series colours with a fixed meaning, so the same line is the same colour on every page.
// `--chart-1` to `--chart-5` are a categorical palette without red or green (see styles.css);
// red and green are kept for bad and good (`--destructive`, `--success`).

/** p50, p95 and p99 are these everywhere. The previous window is dashed and `--muted-foreground`. */
export const PERCENTILE_COLOR = {
  p50: "--chart-1",
  p95: "--chart-4",
  p99: "--chart-5",
} as const;

/** The colour of a series named "p50", "p95" or "p99"; undefined for any other name. */
export function percentileColor(label: string): string | undefined {
  return (PERCENTILE_COLOR as Record<string, string>)[label.toLowerCase()];
}

/** Colours for series with no fixed meaning (one line per instance, one band per type). */
export const CATEGORY_COLORS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
] as const;

/** The category colour at `index`, wrapping round. */
export function categoryColor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length] as string;
}
