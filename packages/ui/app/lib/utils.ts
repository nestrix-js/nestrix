import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * A selected table or list row. `bg-muted` alone is 1.09:1 against the page in light mode, so the
 * row also gets an inset bar on its left edge and a heavier weight, and stays distinct from hover.
 */
export const SELECTED_ROW =
  "bg-muted font-medium shadow-[inset_3px_0_0_var(--foreground)]";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
