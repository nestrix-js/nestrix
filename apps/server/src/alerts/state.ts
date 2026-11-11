/**
 * The alert state machine, as a pure function so it can be tested without a database and reused
 * by other rule kinds (P7-04's burn-rate rules).
 *
 * States: `ok` (also: no row yet), `pending` (breaching for less than `forMinutes`), `firing`.
 *
 * - ok + breach: `pending` from now; with `forMinutes` 0, straight to `firing` (notify firing).
 * - pending + breach held for `forMinutes`: `firing` (notify firing; `startedAt` is when it
 *   became pending).
 * - pending + no breach: `ok`, silently.
 * - firing + no breach: `ok` (notify resolved).
 * - **No data** (`value` null: fewer requests than the rule's minimum) changes nothing: a firing
 *   alert is not resolved because traffic stopped (a dead service sends no spans), and a pending
 *   one does not fire.
 *
 * Evaluations come about a minute apart, so "held for N minutes" allows a few seconds of timer
 * drift (`FOR_TOLERANCE_MS`): with `forMinutes` 2 the rule fires at the third consecutive
 * breaching evaluation (0, 1, 2 minutes), not the fourth.
 */

export type AlertStateName = "ok" | "pending" | "firing";

export interface StoredState {
  state: AlertStateName;
  /** Unix ms when the rule entered `state`. */
  sinceMs: number;
}

export type Notify = "firing" | "resolved";

export interface Transition {
  next: StoredState;
  /** A notification to send, if the transition calls for one. */
  notify: Notify | undefined;
  /** Unix ms the alert's condition started: the pending or firing `since`. */
  startedAtMs: number;
}

export const FOR_TOLERANCE_MS = 5_000;

export function transition(
  current: StoredState | undefined,
  value: number | null,
  threshold: number,
  forMinutes: number,
  nowMs: number,
): Transition {
  const state = current ?? { state: "ok" as const, sinceMs: nowMs };
  if (value === null || !Number.isFinite(value)) {
    return { next: state, notify: undefined, startedAtMs: state.sinceMs };
  }
  const breach = value > threshold;
  const forMs = forMinutes * 60_000;
  switch (state.state) {
    case "ok":
      if (!breach) {
        return { next: state, notify: undefined, startedAtMs: state.sinceMs };
      }
      if (forMs === 0) {
        return {
          next: { state: "firing", sinceMs: nowMs },
          notify: "firing",
          startedAtMs: nowMs,
        };
      }
      return {
        next: { state: "pending", sinceMs: nowMs },
        notify: undefined,
        startedAtMs: nowMs,
      };
    case "pending":
      if (!breach) {
        return {
          next: { state: "ok", sinceMs: nowMs },
          notify: undefined,
          startedAtMs: nowMs,
        };
      }
      if (nowMs - state.sinceMs + FOR_TOLERANCE_MS >= forMs) {
        return {
          next: { state: "firing", sinceMs: state.sinceMs },
          notify: "firing",
          startedAtMs: state.sinceMs,
        };
      }
      return { next: state, notify: undefined, startedAtMs: state.sinceMs };
    case "firing":
      if (breach) {
        return { next: state, notify: undefined, startedAtMs: state.sinceMs };
      }
      return {
        next: { state: "ok", sinceMs: nowMs },
        notify: "resolved",
        startedAtMs: state.sinceMs,
      };
  }
}
