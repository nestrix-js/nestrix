// Loads `runtime.ts` (the SDK, exporters and dashboard) with a dynamic `import()` (D-99, #41).
//
// No top-level `await` (AGENTS.md rule 4): the import runs inside a function and its promise is
// awaited by Nest, through the async factory of the `NESTRIX_RUNTIME` provider, before
// `NestrixCore` is constructed. So `NestrixCore` still sets everything up synchronously in its
// constructor, during `NestFactory.create`, as before; only the moment the code is loaded moves.
// `NestrixModule.forRoot()` starts the load early (it is known to be on there), so by the time Nest
// constructs providers the module is normally already evaluated.
import { diagnostics } from "./diagnostics.js";

export type NestrixRuntime = typeof import("./runtime.js");

let loading: Promise<NestrixRuntime | undefined> | undefined;

/**
 * The runtime module, loaded once per process. Never rejects: a failed load resolves to
 * `undefined`, is counted, and leaves `NestrixCore` inert (rule 1: the host still boots).
 */
export function loadNestrixRuntime(): Promise<NestrixRuntime | undefined> {
  if (loading === undefined) {
    try {
      loading = import("./runtime.js").then(
        (runtime) => runtime,
        (error: unknown) => {
          diagnostics.countFailure("core.runtime-load", error);
          return undefined;
        },
      );
    } catch (error) {
      diagnostics.countFailure("core.runtime-load", error);
      return Promise.resolve(undefined);
    }
  }
  return loading;
}
