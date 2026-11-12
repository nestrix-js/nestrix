import { barPercent } from "@/components/kit/format";

/**
 * A table cell's value with a proportional bar: the bar is `value` over `max` (the column's or
 * the window's largest), the number sits at the right in monospace so a column of them aligns.
 * `label` is the formatted value ("245 ms"); `color` is a CSS custom property.
 */
export function BarCell({
  value,
  max,
  label,
  color = "--chart-1",
  testId,
}: {
  value: number;
  max: number;
  label: string;
  color?: string;
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
          style={{ width: `${pct}%`, background: `var(${color})` }}
        />
      </span>
      <span className="w-16 text-right font-mono tabular-nums">{label}</span>
    </span>
  );
}
