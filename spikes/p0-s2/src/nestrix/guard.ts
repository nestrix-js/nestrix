// Rule 1: every subscriber/wrapper body catches everything. Failures are counted,
// never thrown into the host. `faults` lets tests inject a throw into a named body
// to prove the catch is there.

export const failures: Record<string, number> = {};
export const faults = new Set<string>();

export function noteFailure(where: string): void {
  failures[where] = (failures[where] ?? 0) + 1;
}

/** Throws if a fault was injected for `where`. Call it inside a guarded body. */
export function maybeFault(where: string): void {
  if (faults.has(where)) throw new Error(`injected fault in ${where}`);
}

/** Runs `fn`, swallowing and counting anything it throws. */
export function safe<T>(where: string, fn: () => T): T | undefined {
  try {
    maybeFault(where);
    return fn();
  } catch {
    noteFailure(where);
    return undefined;
  }
}

/** Copies `name` and `length` so the wrapper looks like the original. */
export function mirror<F extends (...args: never[]) => unknown>(
  wrapper: F,
  original: (...args: never[]) => unknown,
): F {
  try {
    Object.defineProperty(wrapper, "name", { value: original.name });
    Object.defineProperty(wrapper, "length", { value: original.length });
  } catch {
    noteFailure("mirror");
  }
  return wrapper;
}
