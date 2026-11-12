/** A tiny bar chart in plain SVG: one bar per value, scaled to the largest, `label` for screen readers. */
export function Sparkline({
  values,
  label,
  width = 96,
  height = 24,
}: {
  values: readonly number[];
  label: string;
  width?: number;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  const slot = width / Math.max(1, values.length);
  const barWidth = Math.max(1, slot - 1);
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="text-destructive"
    >
      <title>{label}</title>
      {values.map((value, i) => {
        if (value <= 0) return null;
        const h = Math.max(2, (value / max) * height);
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the bucket
            key={i}
            x={i * slot}
            y={height - h}
            width={barWidth}
            height={h}
            fill="currentColor"
            data-value={value}
          />
        );
      })}
    </svg>
  );
}
