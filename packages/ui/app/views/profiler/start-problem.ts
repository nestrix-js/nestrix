import { ApiRequestError } from "@/lib/api";

/** A `403 forbidden` on a start is the browser not sending `Sec-Fetch-Site` (HTTPS or localhost only). */
export const NEEDS_SECURE_ORIGIN =
  "Starting a capture needs HTTPS or localhost: browsers send the Sec-Fetch-Site header the server checks only to those origins. Open the dashboard over HTTPS (or through localhost) and try again.";

export const isForbidden = (error: Error) =>
  error instanceof ApiRequestError &&
  error.status === 403 &&
  error.code === "forbidden";

/**
 * What to show when an embedded start is refused. A `429` is the cool-down after the previous
 * capture.
 */
export function startProblem(error: Error): string {
  if (isForbidden(error)) return NEEDS_SECURE_ORIGIN;
  if (
    error instanceof ApiRequestError &&
    error.status === 429 &&
    error.retryAfterSeconds !== undefined
  ) {
    return `Available again in ${error.retryAfterSeconds} s: a new capture can start 10 s after the previous one ended.`;
  }
  return error.message;
}

/** Seconds left of a `429`'s `Retry-After`, counted from when it arrived (`atMs`). */
export function retryRemaining(
  retryAfterSeconds: number,
  atMs: number,
  nowMs: number,
): number {
  return Math.max(0, Math.ceil(retryAfterSeconds - (nowMs - atMs) / 1000));
}

/**
 * What to show when a remote start is refused: `404` the instance is gone (the list shows those
 * seen in the last 2 minutes), `409` another capture is pending or running for it, `429` the
 * 10 s cool-down (`remaining` counts down).
 */
export function remoteStartProblem(
  error: Error,
  instanceLabel: string,
  remaining: number | null,
): string {
  if (isForbidden(error)) return NEEDS_SECURE_ORIGIN;
  if (error instanceof ApiRequestError) {
    if (error.status === 404) {
      return `Instance ${instanceLabel} has not checked in lately: it may have stopped or restarted. Pick it again once it is listed.`;
    }
    if (error.status === 409) {
      return `A capture is already pending or running for instance ${instanceLabel}.`;
    }
    if (error.status === 429 && remaining !== null) {
      return remaining > 0
        ? `Instance ${instanceLabel}: available again in ${remaining} s, a new capture can start 10 s after the previous one ended.`
        : `Instance ${instanceLabel} can be captured again now.`;
    }
  }
  return error.message;
}
