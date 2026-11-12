import { sparklinePoints } from "@/components/kit/sparkline-points";

const cssVar = (name: string) => `var(${name})`;

/**
 * A line over the values of a series, in one colour (`color` is a CSS custom property such as
 * `--chart-1`). `area` fills under it; `stretch` fills the width of the container.
 */
export function TrendLine({
  values,
  color,
  label,
  width = 96,
  height = 28,
  area = false,
  stretch = false,
}: {
  values: readonly number[];
  color: string;
  label: string;
  width?: number;
  height?: number;
  /** Fills the space under the line. */
  area?: boolean;
  /** Fills the width of its container (the line keeps its stroke width). */
  stretch?: boolean;
}) {
  if (values.length === 0) return null;
  const points = sparklinePoints(values, width, height);
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="trend"
      width={stretch ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="shrink-0 overflow-visible"
    >
      <title>{label}</title>
      {area && (
        <polygon
          points={`2,${height} ${points} ${width - 2},${height}`}
          fill={cssVar(color)}
          opacity={0.12}
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={cssVar(color)}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
