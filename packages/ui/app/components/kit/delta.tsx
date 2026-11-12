import { ArrowDown, ArrowUp } from "lucide-react";

import type { ChipTone, Tone } from "@/components/kit/format";
import { cn } from "@/lib/utils";

/** Text colour per tone: worse is destructive, better is success, neutral is muted. */
export const toneText: Record<Tone, string> = {
  worse: "text-destructive-text",
  better: "text-success",
  neutral: "text-muted-foreground",
};

/** Chip and badge colours per tone; `info` and `warn` are for facts and caution. */
export const chipTone: Record<ChipTone, string> = {
  worse: "bg-destructive/10 text-destructive-text",
  better: "bg-success/8 text-success",
  neutral: "bg-secondary text-secondary-foreground",
  info: "bg-info/10 text-info",
  warn: "bg-warning/15 text-warning-text",
};

/**
 * A formatted change ("+12%", "−3 pt", "—") with an arrow for its direction. The arrow follows
 * the sign; the colour says good or bad (never alone: the sign is in the text). "—" is unknown.
 */
export function Delta({
  text,
  tone,
  title,
}: {
  text: string;
  tone: Tone;
  title?: string;
}) {
  const unknown = text === "—";
  // The arrow shows which way the number moved; the colour says whether that is good or bad
  // (Apdex falling is worse and points down).
  const rising = /^\+/.test(text);
  const falling = /^[−-]/.test(text);
  return (
    <span
      data-testid="delta"
      data-tone={unknown ? "unknown" : tone}
      title={title}
      className={cn(
        "inline-flex items-center gap-0.5 whitespace-nowrap font-mono text-xs",
        unknown ? "text-muted-foreground" : toneText[tone],
      )}
    >
      {!unknown && tone !== "neutral" && rising && (
        <ArrowUp className="size-3" aria-hidden />
      )}
      {!unknown && tone !== "neutral" && falling && (
        <ArrowDown className="size-3" aria-hidden />
      )}
      {text}
    </span>
  );
}
