import type * as React from "react";

import { chipTone } from "@/components/kit/delta";
import type { ChipTone } from "@/components/kit/format";
import { cn } from "@/lib/utils";

/**
 * A small status pill. Always put words in it (a status, a state, a count with its unit): the
 * colour reinforces the text and never carries the meaning alone.
 */
export function Chip({
  tone = "neutral",
  icon,
  className,
  children,
  ...props
}: {
  tone?: ChipTone;
  /** An optional leading icon (decorative). */
  icon?: React.ReactNode;
} & React.ComponentProps<"span">) {
  return (
    <span
      data-slot="chip"
      data-tone={tone}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap",
        chipTone[tone],
        className,
      )}
      {...props}
    >
      {icon ? (
        <span aria-hidden className="inline-flex [&_svg]:size-3">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
