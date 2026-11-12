import type { TimeCategory } from "@/lib/trace-time";

/**
 * Background of each time category, shared by the "where the time went" bar and the waterfall
 * bars. Theme tokens only. A slow database call is `bg-warning` in the waterfall (a state, not
 * a category), so no category uses that token.
 */
export const CATEGORY_BG: Record<TimeCategory, string> = {
  database: "bg-chart-4",
  cache: "bg-flame-deps",
  http: "bg-flame-runtime",
  messaging: "bg-chart-5",
  code: "bg-flame-app",
  other: "bg-muted-foreground/50",
};
