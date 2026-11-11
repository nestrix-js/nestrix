/**
 * `nestrixSpanProcessor()`: for a host that owns its OpenTelemetry SDK (3.x), to add to
 * its own `spanProcessors` so the dashboard shows its traces (architecture §4.5).
 *
 * Public entry. Its declaration must reference nothing but the SDK's `SpanProcessor`
 * type: the store's types mirror the private query-API protocol package and must not be
 * reachable from the published `index.d.ts`.
 */
import type { SpanProcessor } from "@opentelemetry/sdk-trace";
import { diagnostics } from "../diagnostics.js";
import { createStoreProcessor, noopProcessor } from "./processor.js";
import { getOrCreateStore } from "./store.js";

/**
 * A span processor that feeds the Nestrix dashboard's in-memory store. Add it to your
 * own provider when your application registers its OpenTelemetry SDK before Nestrix:
 *
 * ```ts
 * new TracerProvider({ spanProcessors: [yourExportProcessor, nestrixSpanProcessor()] })
 * ```
 *
 * It sees every recording span, including your other instrumentations', and the store
 * applies Nestrix's redaction and your `redact` hook to each before keeping it. It stores
 * nothing while no Nestrix app with the dashboard on is running. Never throws; its
 * `forceFlush` and `shutdown` never reject. Several calls share one store.
 */
export function nestrixSpanProcessor(): SpanProcessor {
  try {
    const store = getOrCreateStore(undefined, diagnostics);
    store.countProcessor();
    return createStoreProcessor(store);
  } catch (error) {
    diagnostics.countFailure("store.processor", error);
    return noopProcessor();
  }
}
