/** HH:mm on the 24-hour clock, in the viewer's time zone. */
export function formatHm(unixMs: number): string {
  const d = new Date(unixMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * What the banner says when the `meta` request fails. `lastGoodAt` is when the last good answer
 * arrived (0 or undefined when none ever did): the pages keep showing that data.
 */
export function lostConnectionText(lastGoodAt: number | undefined): string {
  return lastGoodAt
    ? `Lost connection to the server, showing data from ${formatHm(lastGoodAt)}`
    : "Could not reach the server";
}
