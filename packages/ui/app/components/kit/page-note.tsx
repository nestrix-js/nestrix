import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The one explanatory paragraph under a page header: what the numbers mean on this page, such
 * as how sampling affects them. Plain muted text; never a bordered box.
 */
export function PageNote({
  testId,
  className,
  children,
}: {
  testId: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      data-testid={testId}
      className={cn("text-sm text-muted-foreground", className)}
    >
      {children}
    </p>
  );
}
