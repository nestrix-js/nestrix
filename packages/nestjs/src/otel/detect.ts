/**
 * Silent probes for globals that have no public getter, through `@opentelemetry/api`
 * only (spike P0-S3 Q3). None of them writes to the diag logger or creates a span.
 */
import {
  context,
  createContextKey,
  propagation,
  ROOT_CONTEXT,
} from "@opentelemetry/api";

const PROBE_KEY = createContextKey("nestrix.otel.probe");

/**
 * True when some context manager is registered. The API's no-op manager ignores the
 * context passed to `with()`, so `active()` inside it is ROOT and the value is lost.
 * Synchronous only: a `StackContextManager` passes.
 */
export function hasContextManager(): boolean {
  try {
    const marker = {};
    return context.with(
      ROOT_CONTEXT.setValue(PROBE_KEY, marker),
      () => context.active().getValue(PROBE_KEY) === marker,
    );
  } catch {
    return false;
  }
}

/** True when the registered context manager also carries context across an async hop. Never rejects. */
export async function contextSurvivesAwait(): Promise<boolean> {
  try {
    const marker = {};
    return await context.with(
      ROOT_CONTEXT.setValue(PROBE_KEY, marker),
      async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return context.active().getValue(PROBE_KEY) === marker;
      },
    );
  } catch {
    return false;
  }
}

/** True when a propagator is registered: the no-op propagator reports no fields. */
export function hasPropagator(): boolean {
  try {
    return propagation.fields().length > 0;
  } catch {
    return false;
  }
}

/**
 * Another hook-based APM, as far as public API can tell (D-33). Nest's request and
 * response hooks have no getters, so the only visible slot is the route-triggered hook:
 * if `getOnRouteTriggered()` already returns a function before Nestrix installs its own,
 * something else set it. Duck-typed; returns a description or `undefined`; never throws.
 *
 * Call it before installing Nestrix's route hook. After installing, pass Nestrix's own
 * callback as `ours` to see whether something replaced it later.
 */
export function describeForeignRouteHook(
  httpAdapter: unknown,
  ours?: unknown,
): string | undefined {
  try {
    if (httpAdapter === null || typeof httpAdapter !== "object") return;
    const getter = (httpAdapter as { getOnRouteTriggered?: unknown })
      .getOnRouteTriggered;
    if (typeof getter !== "function") return;
    const current: unknown = getter.call(httpAdapter);
    if (typeof current !== "function" || current === ours) return;
    const name = current.name ? ` ("${current.name}")` : "";
    return ours === undefined
      ? `Another tool already set Nest's route-triggered hook${name}. Only one hook-based APM can run per process: it most likely also set the request hook, which Nestrix will replace.`
      : `Another tool replaced Nestrix's route-triggered hook${name} after Nestrix installed it. Only one hook-based APM can run per process: Nestrix's request hook was most likely replaced too.`;
  } catch {
    return;
  }
}
