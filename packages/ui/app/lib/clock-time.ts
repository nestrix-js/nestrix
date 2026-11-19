// One time format for the trace page: local time, 24 hour clock, milliseconds, for example
// "2026-11-11 20:26:40.123". The zone is shown once per page, as "UTC+8". The exact instant
// is available as ISO 8601 UTC in a tooltip.

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** "2026-11-11 20:26:40.123" in the viewer's local time. */
export function formatClockTime(unixMs: number): string {
  const d = new Date(unixMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** "UTC+8", "UTC-3:30" or "UTC" for the viewer's local offset at that instant. */
export function formatZone(unixMs: number): string {
  const offset = -new Date(unixMs).getTimezoneOffset();
  if (offset === 0) return "UTC";
  const abs = Math.abs(offset);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${offset < 0 ? "-" : "+"}${hours}${minutes === 0 ? "" : `:${pad(minutes)}`}`;
}
