import { STANDALONE_WINDOW_MINUTES } from "@nestrix-js/protocol";

/** "15 min", "60 min", "6 h", "24 h", "7 d", "30 d": a window length as the time pickers show it. */
export function windowLabel(minutes: number): string {
  if (minutes >= 2880 && minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes >= 360 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/**
 * The windows a time picker offers: those `MetaResponse.statistics.windowMinutesOptions` lists
 * (15 and 60 until the meta answer arrives and when embedded; the standalone server adds 6 h to
 * 30 d as far as its retention reaches, issue #29).
 */
export function windowChoices(
  options: readonly number[] | undefined,
): { value: number; label: string }[] {
  const known: readonly number[] = STANDALONE_WINDOW_MINUTES;
  return (options ?? [15, 60])
    .filter((m) => known.includes(m))
    .map((value) => ({ value, label: windowLabel(value) }));
}
