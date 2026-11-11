/**
 * Paging cursors: opaque strings `<processId>.<kind><seq in base 36>`. The process id is
 * random per process (the "epoch"), so a cursor from another process, or from before a
 * restart, never matches and the query answers `reset: true`. `kind` keeps trace-list
 * and error-list cursors apart.
 */

export type CursorKind = "t" | "e";

export function encodeCursor(
  processId: string,
  kind: CursorKind,
  seq: number,
): string {
  return `${processId}.${kind}${seq.toString(36)}`;
}

/** The sequence number, or `undefined` for a cursor of another process, kind or shape. */
export function decodeCursor(
  cursor: string,
  processId: string,
  kind: CursorKind,
): number | undefined {
  if (typeof cursor !== "string") return undefined;
  const prefix = `${processId}.${kind}`;
  if (!cursor.startsWith(prefix)) return undefined;
  const digits = cursor.slice(prefix.length);
  if (!/^[0-9a-z]{1,11}$/.test(digits)) return undefined;
  const seq = Number.parseInt(digits, 36);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}
