import { heatLevel, heatOpacity } from "@/components/kit/format";

/**
 * A rows by columns grid of squares whose intensity follows the value (a weekday by hour view).
 * `values[row][column]`; `color` is a CSS custom property. Cells say their value in a tooltip;
 * `format` writes it. `label` states the takeaway for screen readers.
 */
export function Heatmap({
  rows,
  columns,
  values,
  color = "--chart-1",
  format = (n) => String(n),
  label,
  testId = "heatmap",
  columnLabelEvery = 1,
}: {
  rows: readonly string[];
  columns: readonly string[];
  values: readonly (readonly number[])[];
  color?: string;
  format?: (value: number) => string;
  label: string;
  testId?: string;
  /** Show every n-th column label (24 hours read better every 3rd). */
  columnLabelEvery?: number;
}) {
  const max = Math.max(0, ...values.flat());
  return (
    <div
      role="img"
      aria-label={label}
      data-testid={testId}
      className="overflow-x-auto"
    >
      <div
        className="grid min-w-max gap-0.5 text-xs text-muted-foreground"
        style={{
          gridTemplateColumns: `auto repeat(${columns.length}, minmax(14px, 1fr))`,
        }}
      >
        <span />
        {columns.map((c, i) => (
          <span
            key={c}
            className="text-center font-mono text-[10px]"
            aria-hidden
          >
            {i % columnLabelEvery === 0 ? c : ""}
          </span>
        ))}
        {rows.map((row, r) => (
          <HeatRow
            key={row}
            row={row}
            columns={columns}
            values={values[r] ?? []}
            max={max}
            color={color}
            format={format}
          />
        ))}
      </div>
    </div>
  );
}

function HeatRow({
  row,
  columns,
  values,
  max,
  color,
  format,
}: {
  row: string;
  columns: readonly string[];
  values: readonly number[];
  max: number;
  color: string;
  format: (value: number) => string;
}) {
  return (
    <>
      <span className="pr-2 text-right" aria-hidden>
        {row}
      </span>
      {columns.map((c, i) => {
        const value = values[i] ?? 0;
        const level = heatLevel(value, max);
        return (
          <span
            key={c}
            data-level={level}
            title={`${row} ${c}: ${format(value)}`}
            className="aspect-square min-h-3.5 rounded-sm bg-muted"
            style={
              level > 0
                ? {
                    background: `color-mix(in oklch, var(${color}) ${Math.round(heatOpacity(level) * 100)}%, transparent)`,
                  }
                : undefined
            }
          />
        );
      })}
    </>
  );
}
