/**
 * Where level 2 method wrappers report every call, before sampling (phase 3, backlog P3-00).
 *
 * The wrappers (P3-02) call `methodCallSink?.record(...)` once per completed call, whether or not
 * the call got a span. The class statistics (P3-04) install the sink while the dashboard is on.
 * Kept in its own module so the two tasks share one small contract.
 *
 * `record` must be cheap (it runs on every wrapped call) and must never throw; callers still
 * wrap it in try/catch (rule 1).
 */

/** Same values as `ClassKind` in `@nestrix-js/protocol`. */
export type MethodClassKind =
  | "controller"
  | "service"
  | "repository"
  | "processor"
  | "provider"
  | "guard"
  | "pipe"
  | "interceptor"
  | "filter";

export interface MethodCallSink {
  /**
   * One completed call. `durationMs` is wall time from call to return, or to settlement for a
   * plain native promise. `error` is true when the method threw or its promise rejected.
   */
  record(
    className: string,
    kind: MethodClassKind,
    method: string,
    durationMs: number,
    error: boolean,
  ): void;
}

let current: MethodCallSink | undefined;

/** The installed sink, or `undefined` when no dashboard is collecting class statistics. */
export function getMethodCallSink(): MethodCallSink | undefined {
  return current;
}

/** Installs (or with `undefined`, removes) the sink. Returns a disposer that removes it if still installed. */
export function setMethodCallSink(
  sink: MethodCallSink | undefined,
): () => void {
  current = sink;
  return () => {
    if (current === sink) current = undefined;
  };
}
