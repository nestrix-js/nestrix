// Q6 cost benchmark. Run: `node bench/cost.ts` from spikes/p0-s6 (Node strips the types).
// The driver starts one child process per tracing configuration, because OpenTelemetry globals can be
// registered only once per process. Each measurement: warm-up, then RUNS timed runs; median and
// min-max are reported in nanoseconds per operation.
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const RUNS = 9;
const CONFIGS = ["api-noop", "sdk-unsampled", "sdk-recording"] as const;
type Config = (typeof CONFIGS)[number];
const SIZES = [1, 10, 100];

interface Stat {
  median: number;
  min: number;
  max: number;
}

function stat(samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length / 2)] as number,
    min: s[0] as number,
    max: s.at(-1) as number,
  };
}

let sink = 0;

function time(iterations: number, fn: (i: number) => void): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / iterations;
}

function measure(iterations: number, fn: (i: number) => void): Stat {
  for (let w = 0; w < 3; w++) time(iterations, fn); // warm-up
  const samples: number[] = [];
  for (let r = 0; r < RUNS; r++) samples.push(time(iterations, fn));
  return stat(samples);
}

async function measureAsync(
  iterations: number,
  fn: () => Promise<number>,
): Promise<Stat> {
  const once = async () => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) sink += await fn();
    return Number(process.hrtime.bigint() - t0) / iterations;
  };
  for (let w = 0; w < 3; w++) await once();
  const samples: number[] = [];
  for (let r = 0; r < RUNS; r++) samples.push(await once());
  return stat(samples);
}

/** A class with n distinct methods (distinct source, so distinct functions as in real code). */
function makeClass(
  n: number,
  name: string,
): new () => Record<string, (a: number) => number> {
  const C = new Function(
    `return class ${name} { constructor() { this.k = 1; } }`,
  )();
  for (let i = 0; i < n; i++) {
    const fn = new Function(
      `return { m${i}(a) { return a + this.k + ${i}; } }`,
    )()[`m${i}`];
    Object.defineProperty(C.prototype, `m${i}`, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  Object.defineProperty(C.prototype, "am", {
    value: new Function("return { async am(a) { return a + this.k; } }")().am,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return C;
}

async function child(config: Config): Promise<void> {
  await import("reflect-metadata");
  const api = await import("@opentelemetry/api");
  if (config !== "api-noop") {
    const { AsyncLocalStorageContextManager } = await import(
      "@opentelemetry/context-async-hooks"
    );
    const sdk = await import("@opentelemetry/sdk-trace");
    const cm = new AsyncLocalStorageContextManager();
    cm.enable();
    api.context.setGlobalContextManager(cm);
    api.trace.setGlobalTracerProvider(
      new sdk.TracerProvider({
        sampler:
          config === "sdk-unsampled"
            ? new sdk.AlwaysOffSampler()
            : new sdk.AlwaysOnSampler(),
        spanProcessors: [new sdk.NoopSpanProcessor()],
      }),
    );
  }
  const { createInstanceDecorator } = await import("../src/wrap.ts");
  const out: Record<string, unknown> = {};

  // Sanity: the configuration produces the kind of span it claims.
  const probe = api.trace.getTracer("probe").startSpan("probe");
  out.probeRecording = probe.isRecording();
  probe.end();

  for (const n of SIZES) {
    const rows: Record<string, unknown> = {};
    // Per-call: round-robin over all n methods, so wrapper call sites see n different targets.
    const Raw = makeClass(n, `Raw${n}`);
    const raw = new Raw();
    const names = Array.from({ length: n }, (_, i) => `m${i}`);
    const ITER = 200_000;
    rows.callRaw = measure(ITER, (i) => {
      sink += (raw[names[i % n] as string] as (a: number) => number)(i);
    });
    for (const strategy of ["own", "proto"] as const) {
      const C = makeClass(n, `W${strategy}${n}`);
      const decorate = createInstanceDecorator({ strategy });
      const inst = decorate(new C()) as Record<string, (a: number) => number>;
      rows[`call_${strategy}`] = measure(ITER, (i) => {
        sink += (inst[names[i % n] as string] as (a: number) => number)(i);
      });

      // Per-instance: `new C()` plus decoration, with the per-class plan already cached (the
      // request-scoped case), against `new C()` alone. Plan building is timed separately (first instance).
      const C2 = makeClass(n, `I${strategy}${n}`);
      const decorate2 = createInstanceDecorator({ strategy });
      const t0 = process.hrtime.bigint();
      decorate2(new C2());
      rows[`firstInstance_${strategy}`] = Number(process.hrtime.bigint() - t0);
      const NI = 20_000;
      rows[`instance_${strategy}`] = measure(NI, () => {
        sink += (decorate2(new C2()) as { k: number }).k;
      });
    }
    const R2 = makeClass(n, `RI${n}`);
    rows.instanceRaw = measure(20_000, () => {
      sink += (new R2() as unknown as { k: number }).k;
    });
    out[`n${n}`] = rows;
  }

  // Inside an active parent span (as during a request): fast path off vs on. In sdk-unsampled the
  // parent is non-recording, so the fast path skips span creation; in sdk-recording it does not apply.
  if (config !== "api-noop") {
    const parent = api.trace.getTracer("parent").startSpan("parent");
    const parentCtx = api.trace.setSpan(api.context.active(), parent);
    const C = makeClass(10, "InParent");
    const slow = createInstanceDecorator({ strategy: "own" })(
      new C(),
    ) as Record<string, (a: number) => number>;
    const fast = createInstanceDecorator({
      strategy: "own",
      skipUnderNonRecordingParent: true,
    })(new C()) as Record<string, (a: number) => number>;
    const names = Array.from({ length: 10 }, (_, i) => `m${i}`);
    api.context.with(parentCtx, () => {
      out.inParentSlow = measure(200_000, (i) => {
        sink += (slow[names[i % 10] as string] as (a: number) => number)(i);
      });
      out.inParentFast = measure(200_000, (i) => {
        sink += (fast[names[i % 10] as string] as (a: number) => number)(i);
      });
    });
    parent.end();
  }

  // Async method: the wrapper adds a .then() to end the span.
  {
    const C = makeClass(1, "AsyncRaw");
    const raw = new C() as unknown as { am(a: number): Promise<number> };
    const W = makeClass(1, "AsyncWrapped");
    const w = createInstanceDecorator({ strategy: "own" })(new W()) as {
      am(a: number): Promise<number>;
    };
    out.asyncRaw = await measureAsync(100_000, () => raw.am(1));
    out.asyncWrapped = await measureAsync(100_000, () => w.am(1));
  }
  out.sink = sink;
  console.log(JSON.stringify(out));
}

function fmt(s: Stat): string {
  return `${s.median.toFixed(1)} (${s.min.toFixed(1)}-${s.max.toFixed(1)})`;
}

function driver(): void {
  const self = fileURLToPath(import.meta.url);
  console.log(
    `Node ${process.version}, ${os.cpus()[0]?.model ?? "?"} x${os.cpus().length}, ${os.platform()} ${os.release()}, ${Math.round(os.totalmem() / 2 ** 30)} GiB`,
  );
  console.log(
    `median (min-max) ns per operation, ${RUNS} runs after 3 warm-up runs\n`,
  );
  for (const config of CONFIGS) {
    const json = execFileSync(process.execPath, [self, config], {
      encoding: "utf8",
    });
    // biome-ignore lint/suspicious/noExplicitAny: report shape
    const r = JSON.parse(json.trim().split("\n").at(-1) as string) as any;
    console.log(`### ${config} (span.isRecording() = ${r.probeRecording})\n`);
    console.log(
      "| methods | call raw | call own | call proto | new raw | new+decorate own | new+decorate proto | first instance own / proto (ns, one sample) |",
    );
    console.log("|---|---|---|---|---|---|---|---|");
    for (const n of SIZES) {
      const x = r[`n${n}`];
      console.log(
        `| ${n} | ${fmt(x.callRaw)} | ${fmt(x.call_own)} | ${fmt(x.call_proto)} | ${fmt(x.instanceRaw)} | ${fmt(x.instance_own)} | ${fmt(x.instance_proto)} | ${x.firstInstance_own} / ${x.firstInstance_proto} |`,
      );
    }
    console.log(
      `\nasync method, own: raw ${fmt(r.asyncRaw)} vs wrapped ${fmt(r.asyncWrapped)}`,
    );
    if (r.inParentSlow) {
      console.log(
        `inside an active parent span, 10 methods, own: fast path off ${fmt(r.inParentSlow)} vs on ${fmt(r.inParentFast)}`,
      );
    }
    console.log("");
  }
}

const arg = process.argv[2] as Config | undefined;
if (arg && (CONFIGS as readonly string[]).includes(arg)) {
  await child(arg);
} else {
  driver();
}
