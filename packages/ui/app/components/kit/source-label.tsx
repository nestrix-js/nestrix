import { cn } from "@/lib/utils";

/** Where a page's or card's figures come from. Every page and card says. */
export type SourceKind = "stats" | "traces";

export const SOURCE_TEXT: Record<SourceKind, string> = {
  stats: "counted before sampling",
  traces: "from sampled traces",
};

/**
 * The line saying where figures come from: `kind` gives the standard wording ("counted before
 * sampling" is exact; "from sampled traces" is what the retained traces show), or pass your own
 * text as `children`.
 */
export function SourceLabel({
  kind,
  children,
  className,
}: {
  kind?: SourceKind;
  children?: string;
  className?: string;
}) {
  return (
    <span
      data-testid="source"
      className={cn("text-xs text-muted-foreground", className)}
    >
      {children ?? (kind ? SOURCE_TEXT[kind] : "")}
    </span>
  );
}
