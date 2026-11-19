import {
  type SourceKind,
  usePageSourceKind,
  withoutPageSource,
} from "@/components/kit/page-source";
import { cn } from "@/lib/utils";

export type { SourceKind };

export const SOURCE_TEXT: Record<SourceKind, string> = {
  stats: "counted before sampling",
  traces: "from sampled traces",
};

/**
 * The line saying where figures come from: `kind` gives the standard wording ("counted before
 * sampling" is exact; "from sampled traces" is what the retained traces show), or pass your own
 * text as `children`. Set `pageLevel` for the page header's own line; any other label leaves out
 * what the page header already says and renders nothing when that is all it said.
 */
export function SourceLabel({
  kind,
  children,
  className,
  pageLevel = false,
}: {
  kind?: SourceKind;
  children?: string;
  className?: string;
  pageLevel?: boolean;
}) {
  const page = usePageSourceKind();
  const text = children ?? (kind ? SOURCE_TEXT[kind] : "");
  const shown = pageLevel ? text : withoutPageSource(text, page);
  if (shown === "") return null;
  return (
    <span
      data-testid="source"
      className={cn("text-xs text-muted-foreground", className)}
    >
      {shown}
    </span>
  );
}
