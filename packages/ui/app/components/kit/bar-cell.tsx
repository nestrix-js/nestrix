import { barPercent } from "@/components/kit/format";

const TONE_COLOR = { worse: "--destructive", better: "--success" } as const;

/**
 * A table cell's value with a proportional bar: the bar is `value` over `max` (the column's or
 * the window's largest), the number sits at the right in monospace so a column of them aligns.
 * `label` is the formatted value ("245 ms"). An amount is `--chart-1`: a long bar is not bad news
 * and a short one is not good news. Red or green only through an explicit `tone`; `color` (a CSS
 * custom property) is for a series with its own meaning.
 */
export function BarCell({
  value,
  max,
  label,
  color = "--chart-1",
  tone,
  testId,
}: {
  value: number;
  max: number;
  label: string;
  color?: string;
  /** Red (`worse`) or green (`better`); wins over `color`. */
  tone?: keyof typeof TONE_COLOR;
  /** `data-testid` of the bar itself; it also carries `data-pct`. */
  testId?: string;
}) {
  const pct = barPercent(value, max);
  return (
    <span className="flex items-center justify-end gap-2">
      <span
        aria-hidden="true"
        className="h-1.5 w-24 shrink overflow-hidden rounded-full bg-muted"
      >
        <span
          data-testid={testId}
          data-pct={pct.toFixed(1)}
          className="block h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: `var(${tone ? TONE_COLOR[tone] : color})`,
          }}
        />
      </span>
      <span className="w-16 text-right font-mono tabular-nums">{label}</span>
    </span>
  );
}
