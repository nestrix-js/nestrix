import { ArrowDown, ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Tone } from "@/views/overview/overview-format";

export const toneText: Record<Tone, string> = {
  worse: "text-destructive",
  better: "text-success",
  neutral: "text-muted-foreground",
};

/** A formatted change with an arrow for its direction; the colour says good or bad, never alone. */
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
