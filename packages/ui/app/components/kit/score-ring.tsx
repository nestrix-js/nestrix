import { ringDasharray } from "@/components/kit/format";

/**
 * A score as a ring that is `score` percent full with the number inside (the Overview's health
 * score). `color` is a CSS custom property; `caption` is the small word under the number.
 */
export function ScoreRing({
  score,
  color,
  label,
  caption = "health",
  valueTestId,
}: {
  score: number;
  color: string;
  label: string;
  caption?: string;
  valueTestId?: string;
}) {
  const r = 48;
  return (
    <div className="relative size-28 shrink-0">
      <svg
        viewBox="0 0 112 112"
        role="img"
        aria-label={label}
        className="size-28 -rotate-90"
      >
        <title>{label}</title>
        <circle
          cx="56"
          cy="56"
          r={r}
          fill="none"
          stroke="var(--muted)"
          strokeWidth="10"
        />
        <circle
          cx="56"
          cy="56"
          r={r}
          fill="none"
          stroke={`var(${color})`}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={ringDasharray(score / 100, r)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          data-testid={valueTestId}
          className="text-3xl font-bold leading-none"
        >
          {score}
        </span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </div>
    </div>
  );
}
