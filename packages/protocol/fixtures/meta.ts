import type { MetaResponse } from "../src/index.js";
import { PROTOCOL_VERSION } from "../src/index.js";

export const meta = {
  protocolVersion: PROTOCOL_VERSION,
  processId: "p-8f3k2m1q",
  serverTimeUnixMs: 1_794_400_010_000,
  service: { name: "orders-api", version: "1.4.2", environment: "development" },
  sampling: { owner: "nestrix", rate: 0.25 },
  store: {
    traces: 312,
    spans: 1_874,
    bytes: 4_915_200,
    maxTraces: 1_000,
    maxBytes: 33_554_432,
    evictedTraces: 0,
    droppedSpans: 2,
  },
  statistics: {
    sinceUnixMs: 1_794_399_000_000,
    windowMinutesOptions: [15, 60],
  },
  warnings: [
    {
      code: "sampled",
      message:
        "Traces are sampled at 25%; route statistics count every request.",
    },
  ],
  mode: "embedded",
  profiler: { available: true, running: false },
} satisfies MetaResponse;
