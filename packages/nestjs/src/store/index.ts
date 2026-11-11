/** The dashboard's trace store (P2-03). Internal; `nestrixSpanProcessor` is the public part. */
export {
  DEFAULT_STORE_LIMITS,
  type StoreLimits,
} from "./limits.js";
export { createStoreProcessor } from "./processor.js";
export { nestrixSpanProcessor } from "./span-processor.js";
export {
  type ErrorListQuery,
  getOrCreateStore,
  getStore,
  resetStoreForTests,
  type StoreRedaction,
  type StoreStats,
  type TraceListQuery,
  type TraceStore,
} from "./store.js";
