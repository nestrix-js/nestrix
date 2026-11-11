// Bytes per stored trace (P2-12): heap growth after a forced GC per trace held by the dashboard's
// store, next to the store's own byte estimate, for three trace shapes. Spans go through a real
// SDK 3 provider and the built store processor, as in packages/nestjs/test/fixtures/store-bytes-child.mjs.
//   node src/store-bytes.mjs [--repeats=3] [--name=store-bytes]
// After the per-trace table, each shape is also fed through a store with the DEFAULT limits
// until it is evicting (`--fill`), to show what the defaults hold in real heap.
// Each (shape, repeat) is a fresh child process (`--child=<shape>` is internal).
//   shape 1: server span only
//   shape 2: server span + 5 client spans (database and outgoing HTTP)
//   shape 3: server span + 50 spans with attributes, one with an exception event
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  environmentInfo,
  mdTable,
  median,
  numberOption,
  parseArgs,
  round,
  writeResult,
} from "./lib.mjs";

const SHAPES = {
  1: { label: "server span only", traces: 4000 },
  2: { label: "server + 5 client spans", traces: 2000 },
  3: {
    label: "server + 50 spans, attributes, exception event",
    traces: 500,
  },
};

async function child(shape, fill) {
  const traces = fill ?? SHAPES[shape].traces;
  const nestjsEntry = fileURLToPath(import.meta.resolve("@nestrix/nestjs"));
  const require = createRequire(nestjsEntry);
  const dist = new URL("./", pathToFileURL(nestjsEntry)).href;
  const {
    context,
    SpanKind,
    SpanStatusCode,
    trace,
  } = require("@opentelemetry/api");
  const {
    AsyncLocalStorageContextManager,
  } = require("@opentelemetry/context-async-hooks");
  const { TracerProvider } = require("@opentelemetry/sdk-trace");
  const { createStoreProcessor } = await import(`${dist}store/processor.js`);
  const { getOrCreateStore } = await import(`${dist}store/store.js`);

  const quiet = { logOnce() {}, countFailure() {} };
  const { DEFAULT_STORE_LIMITS } = await import(`${dist}store/limits.js`);
  const store = getOrCreateStore(
    fill ? DEFAULT_STORE_LIMITS : { maxTraces: 1e9, maxBytes: 1e12 },
    quiet,
  );
  store.attach({});
  const provider = new TracerProvider({
    spanProcessors: [createStoreProcessor(store)],
  });
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(provider);
  const tracer = trace.getTracer("@nestrix/nestjs", "0.0.0");
  // Fresh heap strings, as values parsed from a request are in a real app; literals would be
  // shared and understate the cost.
  const fresh = (s) => [...s].join("");

  const server = (i) =>
    tracer.startSpan(fresh("GET /users/:id"), {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": "GET",
        "url.path": fresh(`/users/${i}`),
        "url.scheme": "http",
        "url.query": fresh(`page=${i % 7}&sort=name`),
        "http.route": "/users/:id",
        "http.response.status_code": 200,
        "server.address": fresh("localhost"),
        "server.port": 3000,
        "client.address": fresh("127.0.0.1"),
        "network.protocol.version": "1.1",
        "user_agent.original": fresh(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        ),
        "nestjs.controller": "UsersController",
        "nestjs.handler": "findOne",
      },
    });
  const dbSpan = (i, ctx) => {
    const s = tracer.startSpan(
      "SELECT users",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system.name": "postgresql",
          "db.namespace": "app",
          "db.operation.name": "SELECT",
          "db.query.text": fresh(
            `SELECT id, name, email, created_at FROM users WHERE id = $1 AND tenant_id = $2 LIMIT 1 /* ${i} */`,
          ),
          "server.address": "db.internal",
          "server.port": 5432,
        },
      },
      ctx,
    );
    s.end();
  };
  const httpSpan = (i, ctx) => {
    const s = tracer.startSpan(
      "GET",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "http.request.method": "GET",
          "url.full": fresh(
            `https://api.example.com/v1/profiles/${i}?expand=all`,
          ),
          "server.address": fresh("api.example.com"),
          "server.port": 443,
          "http.response.status_code": 200,
        },
      },
      ctx,
    );
    s.end();
  };
  const stackText = (i) =>
    fresh(
      `Error: upstream ${i} failed\n${Array.from(
        { length: 12 },
        (_, k) =>
          `    at Service.method${k} (/srv/app/dist/service-${k}.js:${10 + k}:${5 + k})`,
      ).join("\n")}`,
    );

  function oneTrace(i) {
    const root = server(i);
    const ctx = trace.setSpan(context.active(), root);
    if (shape === "2") {
      for (let k = 0; k < 5; k++) (k % 2 ? httpSpan : dbSpan)(i, ctx);
    } else if (shape === "3") {
      const handler = tracer.startSpan(
        "UsersController.findOne",
        {
          attributes: {
            "nestjs.type": "handler",
            "code.function.name": "findOne",
          },
        },
        ctx,
      );
      const hctx = trace.setSpan(ctx, handler);
      for (let k = 0; k < 48; k++) {
        if (k % 3 === 0) dbSpan(i, hctx);
        else if (k % 3 === 1) httpSpan(i, hctx);
        else {
          const s = tracer.startSpan(
            `Service.step${k}`,
            { attributes: { "nestjs.type": "provider", step: k } },
            hctx,
          );
          s.end();
        }
      }
      const failing = tracer.startSpan("Service.fail", {}, hctx);
      failing.recordException(
        Object.assign(new Error(`upstream ${i} failed`), {
          stack: stackText(i),
        }),
      );
      failing.setStatus({ code: SpanStatusCode.ERROR, message: "failed" });
      failing.end();
      handler.end();
    }
    root.end();
  }

  // In fill mode the warm-up traces are held (then evicted) too, so the baseline is taken before them.
  globalThis.gc();
  const beforeWarmup = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) {
    // warm up
    oneTrace(-i - 1);
    if (i % 20 === 0) store.drainNow();
  }
  store.drainNow();
  const warm = store.stats();
  globalThis.gc();
  globalThis.gc();
  const before = fill ? beforeWarmup : process.memoryUsage().heapUsed;
  for (let i = 0; i < traces; i++) {
    oneTrace(i);
    // The store's pending queue holds 4096 spans; drain before a burst could overflow it.
    if (i % (shape === "3" ? 20 : 200) === 0) store.drainNow();
  }
  store.drainNow();
  globalThis.gc();
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  const stats = store.stats();
  process.stdout.write(
    JSON.stringify({
      storedTraces: stats.traces,
      evictedTraces: stats.evictedTraces,
      storedBytesEstimate: stats.bytes,
      traces: stats.traces - warm.traces,
      spans: stats.spans - warm.spans,
      heapBytes: after - before,
      estimatedBytes: stats.bytes - warm.bytes,
    }),
  );
}

const args = parseArgs();
const shape = args.child ? String(args.child) : undefined;
if (shape) {
  await child(shape, args.fill ? Number(args.fill) : undefined);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const repeats = numberOption(args, "repeats", 3);
  const name = String(args.name ?? "store-bytes");
  const t0 = performance.now();
  const results = {};
  for (const id of Object.keys(SHAPES)) {
    const runs = [];
    for (let r = 0; r < repeats; r++) {
      const stdout = execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--no-warnings",
          fileURLToPath(import.meta.url),
          `--child=${id}`,
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      const m = JSON.parse(stdout);
      runs.push({
        ...m,
        heapPerTrace: m.heapBytes / m.traces,
        estimatePerTrace: m.estimatedBytes / m.traces,
        spansPerTrace: m.spans / m.traces,
      });
      console.log(`shape ${id} run ${r + 1}/${repeats}`);
    }
    const pick = (f) => median(runs.map(f));
    results[id] = {
      label: SHAPES[id].label,
      spansPerTrace: round(
        pick((x) => x.spansPerTrace),
        1,
      ),
      heapBytesPerTrace: Math.round(pick((x) => x.heapPerTrace)),
      estimateBytesPerTrace: Math.round(pick((x) => x.estimatePerTrace)),
      estimateOverHeap: round(
        pick((x) => x.estimatePerTrace / x.heapPerTrace),
        2,
      ),
      runs,
    };
  }
  const FILLS = { 1: 20000, 2: 20000, 3: 3000 };
  const fills = {};
  for (const [id, n] of Object.entries(FILLS)) {
    const m = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--no-warnings",
          fileURLToPath(import.meta.url),
          `--child=${id}`,
          `--fill=${n}`,
        ],
        { encoding: "utf8", timeout: 120_000 },
      ),
    );
    fills[id] = {
      label: SHAPES[id].label,
      tracesFed: n + 200,
      storedTraces: m.storedTraces,
      evictedTraces: m.evictedTraces,
      estimateMiB: round(m.storedBytesEstimate / 1048576, 1),
      heapGrowthMiB: round(m.heapBytes / 1048576, 1),
    };
    console.log(`fill shape ${id}`);
  }
  const out = {
    environment: environmentInfo(),
    settings: { repeats },
    fillAtDefaultLimits: fills,
    wallSeconds: round((performance.now() - t0) / 1000, 1),
    shapes: results,
  };
  const md = `# Store bytes per trace

${out.environment.platform}, Node ${out.environment.node}. Heap growth after a forced GC (twice) per stored trace, with limits set so nothing is evicted; median of ${repeats} fresh-process runs. The estimate is the store's own \`stats().bytes\` (the figure \`maxBytes\` is compared against).

${mdTable(
  [
    "shape",
    "spans/trace",
    "heap B/trace",
    "estimate B/trace",
    "estimate / heap",
  ],
  Object.entries(results).map(([id, s]) => [
    `${id}: ${s.label}`,
    s.spansPerTrace,
    s.heapBytesPerTrace,
    s.estimateBytesPerTrace,
    s.estimateOverHeap,
  ]),
)}

## At the default limits

Each shape fed through a store with the default limits until it evicts. Heap growth is after a forced GC, measured from before any trace (warm-up included).

${mdTable(
  [
    "shape",
    "traces fed",
    "stored",
    "evicted",
    "estimate MiB",
    "heap growth MiB",
  ],
  Object.entries(fills).map(([id, f]) => [
    `${id}: ${f.label}`,
    f.tracesFed,
    f.storedTraces,
    f.evictedTraces,
    f.estimateMiB,
    f.heapGrowthMiB,
  ]),
)}
`;
  writeResult(name, out, md);
}
