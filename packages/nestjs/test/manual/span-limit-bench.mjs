// Manual probe, not run by Vitest: the per-span cost of `maxSpansPerTrace` far below the limit
// (P13-01, D-78; the figures in docs/architecture.md §4.5 "Span limit per trace").
//
//   pnpm --filter @nestrix-js/nestjs build && node packages/nestjs/test/manual/span-limit-bench.mjs
//
// Two bare TracerProviders with a no-op processor: the stock ParentBased(TraceIdRatioBased(1))
// sampler, and the same wrapped by Nestrix's limiting sampler plus its limit processor. Each run
// starts and ends 200,000 spans in traces of 1,000 (a root and 999 children); 5 warm-up runs,
// then 15 alternating runs each, medians printed. Then the counter on its own.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkg = fileURLToPath(new URL("../..", import.meta.url));
const req = createRequire(`${pkg}package.json`);
const api = await import(pathToFileURL(req.resolve("@opentelemetry/api")).href);
const sdk = await import(
  pathToFileURL(req.resolve("@opentelemetry/sdk-trace")).href
);
const { TraceSpanCounter } = await import(
  pathToFileURL(`${pkg}dist/trace-limit.js`).href
);
const { createLimitingSampler, createSpanLimitProcessor } = await import(
  pathToFileURL(`${pkg}dist/otel/span-limit.js`).href
);

const diagnostics = { logOnce() {}, countFailure() {} };
const noopProcessor = {
  onStart() {},
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

function provider(limited) {
  const inner = new sdk.ParentBasedSampler({
    root: new sdk.TraceIdRatioBasedSampler(1),
  });
  const counter = new TraceSpanCounter(10_000);
  return new sdk.TracerProvider({
    sampler: limited
      ? createLimitingSampler(inner, counter, diagnostics)
      : inner,
    spanProcessors: limited
      ? [createSpanLimitProcessor(counter, diagnostics), noopProcessor]
      : [noopProcessor],
  });
}

function round(tracer) {
  for (let t = 0; t < 200; t++) {
    const root = tracer.startSpan("root", { kind: api.SpanKind.SERVER });
    const ctx = api.trace.setSpan(api.ROOT_CONTEXT, root);
    for (let i = 0; i < 999; i++) {
      tracer
        .startSpan(
          "SELECT",
          {
            kind: api.SpanKind.CLIENT,
            attributes: { "db.system.name": "postgresql" },
          },
          ctx,
        )
        .end();
    }
    root.end();
  }
  return 200 * 1000;
}

function measure(tracer) {
  const start = process.hrtime.bigint();
  const spans = round(tracer);
  return Number(process.hrtime.bigint() - start) / spans;
}

const plain = provider(false).getTracer("bench");
const limited = provider(true).getTracer("bench");
for (let i = 0; i < 5; i++) {
  measure(plain);
  measure(limited);
}
const a = [];
const b = [];
for (let i = 0; i < 15; i++) {
  a.push(measure(plain));
  b.push(measure(limited));
}
const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
const pa = median(a);
const pb = median(b);
console.log(
  `ns/span (start+end, median of 15): plain ${pa.toFixed(0)}, limited ${pb.toFixed(0)}, overhead ${(pb - pa).toFixed(0)} ns (${(((pb - pa) / pa) * 100).toFixed(1)}%)`,
);

const counter = new TraceSpanCounter(10_000);
const ids = Array.from({ length: 200 }, (_, i) =>
  i.toString(16).padStart(32, "0"),
);
const start = process.hrtime.bigint();
let n = 0;
for (let r = 0; r < 20; r++) {
  for (const id of ids) {
    for (let i = 0; i < 1000; i++) {
      counter.tryRecord(id, api.SpanKind.CLIENT, undefined);
      if (i === 0) counter.rootStarted(id);
      n++;
    }
    counter.rootEnding(id, { setAttribute() {} });
  }
}
console.log(
  `counter alone: ${(Number(process.hrtime.bigint() - start) / n).toFixed(1)} ns/span over ${n} calls`,
);
