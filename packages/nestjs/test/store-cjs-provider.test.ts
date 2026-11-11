// Global state: a CommonJS host. Its provider comes from the `.cjs` build of sdk-trace and
// its spans from the `.cjs` build of the API, so they are other classes than the `.mjs`
// ones Nestrix loads (architecture §4.5, P0-S4). nestrixSpanProcessor() is duck-typed and
// must still store those spans.
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { nestrixSpanProcessor } from "../src/store/span-processor.js";
import { getOrCreateStore } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";

const require = createRequire(import.meta.url);
const cjsApi =
  require("@opentelemetry/api") as typeof import("@opentelemetry/api");
const cjsSdk =
  require("@opentelemetry/sdk-trace") as typeof import("@opentelemetry/sdk-trace");
const esmSdk = await import("@opentelemetry/sdk-trace");

const store = getOrCreateStore({}, recordingDiagnostics());
const detach = store.attach({});
const provider = new cjsSdk.TracerProvider({
  spanProcessors: [nestrixSpanProcessor()],
});

afterAll(async () => {
  detach();
  await provider.shutdown();
});

describe("CommonJS host provider", () => {
  it("loads other classes than Nestrix's, and its spans are stored", async () => {
    expect(require.resolve("@opentelemetry/sdk-trace")).toMatch(/\.cjs$/);
    expect(cjsSdk.TracerProvider).not.toBe(esmSdk.TracerProvider);

    const tracer = provider.getTracer("cjs-host");
    const root = tracer.startSpan("cjs-root", { kind: cjsApi.SpanKind.SERVER });
    const child = tracer.startSpan(
      "cjs-child",
      {},
      cjsApi.trace.setSpan(cjsApi.ROOT_CONTEXT, root),
    );
    child.end();
    root.end();
    await provider.forceFlush();

    const traceId = root.spanContext().traceId;
    expect(store.listTraces({ limit: 5 }).items[0]).toMatchObject({
      traceId,
      name: "cjs-root",
      spanCount: 2,
    });
    const stored = store.getTrace(traceId);
    expect(stored?.spans.map((s) => [s.name, s.kind, s.scope])).toEqual([
      ["cjs-root", "server", "cjs-host"],
      ["cjs-child", "internal", "cjs-host"],
    ]);
  });
});
