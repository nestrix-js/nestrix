import Module from "node:module";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { noteFailure } from "./guard.js";

export interface UndiciResult {
  enabled: boolean;
  /** Did constructing the instrumentation replace `Module.prototype.require`? */
  requireHookInstalled: boolean;
}

let instrumentation: UndiciInstrumentation | undefined;
let result: UndiciResult | undefined;

/** Upstream, channel-based. Constructed after the global provider is registered. */
export function enableUndici(): UndiciResult {
  if (result) return result;
  const before = Module.prototype.require;
  try {
    instrumentation = new UndiciInstrumentation();
  } catch {
    noteFailure("undici.enable");
  }
  result = {
    enabled: instrumentation !== undefined,
    requireHookInstalled: Module.prototype.require !== before,
  };
  return result;
}
