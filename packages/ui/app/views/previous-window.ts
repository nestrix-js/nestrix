import type { Tone } from "@/components/kit/format";
import { formatDeltaMs, formatDeltaRate } from "@/views/routes/route-insights";
import { type Change, formatChangePercent } from "@/views/routes/route-kpis";

/** The optional fields an answer carries when the server compares with the previous window. */
export interface PreviousWindowInfo {
  previousCovered?: boolean;
  note?: string | null;
}

/** "—" with the reason as tooltip. */
export const unknownChange = (title: string): Change => ({
  text: "—",
  tone: "neutral",
  title,
});

/**
 * Why there is no change to show, or null when the previous window is covered. An older server
 * sends neither field; that is said too.
 */
export function whyNoPrevious(
  answer: PreviousWindowInfo | undefined,
): string | null {
  if (answer === undefined) return "The previous window has not loaded.";
  if (answer.previousCovered === undefined)
    return "This server does not send a previous window to compare with.";
  if (!answer.previousCovered)
    return answer.note ?? "Statistics do not cover the previous window.";
  return null;
}

const toneOfSign = (n: number): Tone =>
  n > 0 ? "worse" : n < 0 ? "better" : "neutral";

/** A count against the previous one, as a percentage; neither up nor down is good or bad. */
export function countChange(
  before: number | undefined,
  after: number,
  what: string,
): Change {
  if (before === undefined) return unknownChange("No previous window.");
  const text = formatChangePercent(before, after);
  if (text === null) return unknownChange(`No ${what} in the previous window.`);
  return { text, tone: "neutral", title: `${before} before, ${after} now` };
}

/** An error rate against the previous one, in points; higher is worse. */
export function rateChange(
  before: number | null | undefined,
  after: number | null,
): Change {
  if (before == null || after === null)
    return unknownChange("No calls in one of the windows.");
  const diff = after - before;
  return { text: formatDeltaRate(diff), tone: toneOfSign(diff) };
}

/** A duration against the previous one; higher is worse. "—" when either is missing or 0. */
export function msChange(
  before: number | null | undefined,
  after: number | null | undefined,
): Change {
  if (!before || !after)
    return unknownChange("No measurement in one of the windows.");
  return {
    text: formatDeltaMs(after - before),
    tone: toneOfSign(after - before),
  };
}

/** `errors / calls`, or null without calls. */
export const rateOf = (errors: number, calls: number): number | null =>
  calls > 0 ? errors / calls : null;
