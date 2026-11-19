import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The one native `<select>`: the same height, border, focus ring and invalid state as `Input`.
 * `size="sm"` (h-7) is for toolbars, the default (h-8) for forms and page controls.
 */
function Select({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "default" | "sm" }) {
  return (
    <select
      data-slot="select"
      className={cn(
        "rounded-lg border border-border bg-background px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive",
        size === "sm" ? "h-7" : "h-8",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
