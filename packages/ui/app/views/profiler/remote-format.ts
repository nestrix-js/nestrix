import type {
  RemoteProfileState,
  RemoteProfileSummary,
} from "@nestrix-js/protocol";

/** Capture lengths offered for a remote capture, seconds. The server accepts 1 to 120. */
export const REMOTE_DURATION_OPTIONS = [15, 30, 60, 120] as const;
export const REMOTE_DEFAULT_SECONDS = 30;

/** The first 8 characters of an instance id; the full id goes in the tooltip. */
export const shortInstanceId = (id: string) => id.slice(0, 8);

/** `15 seconds`, `1 minute`, `2 minutes`. */
export function durationLabel(seconds: number): string {
  return seconds < 60
    ? `${seconds} seconds`
    : `${seconds / 60} minute${seconds > 60 ? "s" : ""}`;
}

export const stateLabel: Record<RemoteProfileState, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
  expired: "Expired",
};

/** A capture the instance has not finished: the server's `pending` or `running`. */
export const isActive = (c: Pick<RemoteProfileSummary, "state">) =>
  c.state === "pending" || c.state === "running";

/**
 * Where an active capture stands. A `pending` capture waits for the instance's next check-in
 * (every 15 s); a `running` one is capturing until `startedAt + durationMs`, then uploading
 * until the server marks it done.
 */
export function captureStatus(
  capture: Pick<
    RemoteProfileSummary,
    "state" | "requestedAtUnixMs" | "startedAtUnixMs" | "durationMs"
  >,
  nowMs: number,
): { label: string; progress: number | null } {
  if (capture.state === "pending") {
    return {
      label: "Waiting for the instance (checks in every 15 s)",
      progress: null,
    };
  }
  const startedAt = capture.startedAtUnixMs ?? capture.requestedAtUnixMs;
  const elapsed = Math.min(capture.durationMs, Math.max(0, nowMs - startedAt));
  const left = Math.ceil((capture.durationMs - elapsed) / 1000);
  return left > 0
    ? { label: `Capturing… ${left} s left`, progress: elapsed }
    : { label: "Uploading", progress: capture.durationMs };
}
