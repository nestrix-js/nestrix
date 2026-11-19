/**
 * The ingest caps derived from the in-flight memory budget (D-117). `NESTRIX_INGEST_MEMORY_BUDGET_MB`
 * sets the budget; the body limit and the count caps scale with it so that a single request at
 * every cap is still charged less than the budget (otherwise every request at the caps would be
 * answered 413 or 503 forever). At or above the default budget the caps are the defaults.
 *
 * The worst-case charge of one request at the caps, with `B` the body limit (D-116):
 * - protobuf: `2B` (chunks and their join) + `B` (strings) + (messages + spans) x `BYTES_PER_MESSAGE`;
 * - JSON (traces, logs, metrics and the profile upload): `2B` + `2B` (the text and the parsed
 *   strings) + objects x `BYTES_PER_MESSAGE` + (values - objects) x `BYTES_PER_JSON_TOKEN`.
 * Packed metric runs are charged by their decoded size and are not bounded by the caps (as before,
 * D-116 (3)): a crafted metrics body can reach 413 below the body limit.
 */
import { BYTES_PER_JSON_TOKEN, BYTES_PER_MESSAGE } from "./limits.js";

const MIB = 1024 * 1024;

/** The default budget, and the caps that go with it (`DEFAULT_INGEST`). */
export const DEFAULT_INGEST_BUDGET_MIB = 320;
export const DEFAULT_INGEST_CAPS: IngestCaps = Object.freeze({
  maxBodyBytes: 20 * MIB,
  maxSpans: 100_000,
  maxMessages: 400_000,
  maxJsonTokens: 1_200_000,
});

/**
 * Bounds of `NESTRIX_INGEST_MEMORY_BUDGET_MB`, in MiB. 32: the caps are then 2 MiB, 10 000 spans
 * and 40 000 messages, still above a Collector batch (8 192 spans by default) and an SDK batch
 * (512, at most 2 048). 1024: decoded messages live on the V8 heap (measured: up to about 1.25x
 * the budget for message-heavy requests), and Node's default heap limit is about half the memory
 * limit and at most about 2 GiB (measured in the image: 408 MiB at 768 MiB, 2 144 MiB at 4 GiB and
 * at 8 GiB); past 1 GiB a full budget of such requests could exhaust the heap.
 */
export const MIN_INGEST_BUDGET_MIB = 32;
export const MAX_INGEST_BUDGET_MIB = 1024;

export interface IngestCaps {
  /** The body limit, compressed and inflated. */
  readonly maxBodyBytes: number;
  /** Spans (log records, data points) per request. */
  readonly maxSpans: number;
  /** Protobuf submessages, or JSON objects, per request. */
  readonly maxMessages: number;
  /** JSON `{`, `[` and `,` per request. */
  readonly maxJsonTokens: number;
}

/**
 * The caps for a budget of `budgetBytes`: the defaults scaled by `budget / 320 MiB` and rounded
 * down, never above the defaults. A larger budget lets more requests be in flight at once; it does
 * not make one request larger.
 */
export function ingestCapsForBudget(budgetBytes: number): IngestCaps {
  const share = Math.min(1, budgetBytes / (DEFAULT_INGEST_BUDGET_MIB * MIB));
  const d = DEFAULT_INGEST_CAPS;
  return Object.freeze({
    maxBodyBytes: Math.floor(d.maxBodyBytes * share),
    maxSpans: Math.floor(d.maxSpans * share),
    maxMessages: Math.floor(d.maxMessages * share),
    maxJsonTokens: Math.floor(d.maxJsonTokens * share),
  });
}

/** What one request at every cap is charged at most, per body format (formula above). */
export function worstCaseCharge(caps: IngestCaps): {
  protobuf: number;
  json: number;
} {
  const b = caps.maxBodyBytes;
  return {
    protobuf: 3 * b + (caps.maxMessages + caps.maxSpans) * BYTES_PER_MESSAGE,
    json:
      4 * b +
      caps.maxMessages * BYTES_PER_MESSAGE +
      (caps.maxJsonTokens - caps.maxMessages) * BYTES_PER_JSON_TOKEN,
  };
}
