// Shared helpers for the benchmark scripts. Plain ESM JavaScript on purpose: nothing here is
// published, and the child app builds its Nest module with decorator functions, so no TypeScript
// build step stands between `pnpm --filter benchmarks run <script>` and a result.
import { execFile, fork } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import autocannon from "autocannon";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const benchDir = join(here, "..");
export const resultsDir = join(benchDir, "results");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `--key=value` and `--flag` arguments, with `BENCH_<KEY>` environment variables as fallback. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) args[match[1]] = match[2] ?? true;
  }
  return args;
}

export function option(args, key, fallback) {
  const env = process.env[`BENCH_${key.toUpperCase().replaceAll("-", "_")}`];
  const value = args[key] ?? env;
  return value === undefined ? fallback : value;
}

export function numberOption(args, key, fallback) {
  const value = Number(option(args, key, fallback));
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`);
  return value;
}

export function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function writeResult(name, data, markdown) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    join(resultsDir, `${name}.json`),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  if (markdown !== undefined) {
    writeFileSync(join(resultsDir, `${name}.md`), markdown);
  }
  console.log(
    `wrote results/${name}.json${markdown === undefined ? "" : " and .md"}`,
  );
}

export function environmentInfo() {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: `${globalThis.navigator?.hardwareConcurrency ?? "?"} logical`,
    date: new Date().toISOString(),
  };
}

export function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [
    line(headers),
    line(headers.map(() => "---")),
    ...rows.map((r) => line(r.map(String))),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Child processes

/** A free port: bind, read the port, close. Nothing listens there afterwards (a refusing endpoint). */
export function closedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts the sink process (`sink.mjs`) and resolves with its port once it listens.
 * mode `sink` answers 200 to every OTLP POST; `blackhole` accepts and never answers.
 */
export async function startSink(mode) {
  const child = fork(join(here, "sink.mjs"), [mode], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const port = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`sink exited early (${code})`)),
    );
    child.on("message", (m) => {
      if (m?.type === "listening") resolve(m.port);
    });
  });
  child.removeAllListeners("exit");
  const stats = () =>
    new Promise((resolve) => {
      const onMessage = (m) => {
        if (m?.type === "stats") {
          child.off("message", onMessage);
          resolve(m);
        }
      };
      child.on("message", onMessage);
      child.send({ type: "stats" });
    });
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stats,
    async stop() {
      child.kill("SIGKILL");
    },
  };
}

async function rssKb(pid) {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "rss=",
      "-p",
      String(pid),
    ]);
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function httpGetStatus(port, path) {
  return new Promise((resolve) => {
    import("node:http").then(({ get }) => {
      const req = get(
        { host: "127.0.0.1", port, path, agent: false },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", () => resolve(undefined));
    });
  });
}

/**
 * Forks the benchmark app (`app.mjs`) in a fresh process. `startupMs` is the time from just before
 * the spawn to the first 200 on GET /hello, polled from here.
 *
 * env: BENCH_CONFIG, PORT and, for exporting configurations, BENCH_ENDPOINT, BENCH_QUEUE_SIZE.
 */
export async function startApp({
  config,
  port,
  endpoint,
  queueSize,
  execArgv = [],
  env = {},
}) {
  const childEnv = {
    ...process.env,
    ...env,
    BENCH_CONFIG: config,
    PORT: String(port),
  };
  if (endpoint) childEnv.BENCH_ENDPOINT = endpoint;
  if (queueSize) childEnv.BENCH_QUEUE_SIZE = String(queueSize);
  const t0 = performance.now();
  const child = fork(join(here, "app.mjs"), [], {
    env: childEnv,
    execArgv,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    if (stderr.length < 8000) stderr += c;
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const deadline = t0 + 60_000;
  let status;
  while (performance.now() < deadline) {
    if (exited)
      throw new Error(`app (${config}) exited during startup:\n${stderr}`);
    status = await httpGetStatus(port, "/hello");
    if (status === 200) break;
    await sleep(2);
  }
  if (status !== 200) {
    child.kill("SIGKILL");
    throw new Error(
      `app (${config}) did not answer 200 within 60 s:\n${stderr}`,
    );
  }
  const startupMs = performance.now() - t0;

  const request = (type) =>
    new Promise((resolve) => {
      const onMessage = (m) => {
        if (m?.type === type) {
          child.off("message", onMessage);
          resolve(m);
        }
      };
      child.on("message", onMessage);
      child.send({ type });
    });

  return {
    pid: child.pid,
    port,
    startupMs,
    rssKb: () => rssKb(child.pid),
    /** { cpuUserUs, cpuSystemUs, rss, heapUsed, counters? } from inside the child. */
    stats: (type = "stats") => request(type),
    /** Closes the Nest app (which flushes the exporter), then waits for the process to exit. */
    async stop() {
      if (exited) return stderr;
      const done = new Promise((resolve) => child.once("exit", resolve));
      try {
        child.send({ type: "stop" });
      } catch {
        child.kill("SIGKILL");
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await done;
      clearTimeout(timer);
      return stderr;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Load generation

const BIN_US = 10;
const MAX_BINS = 1_000_000; // 10 s at 10 us

/**
 * Runs autocannon against the app. Latency is recorded from autocannon's per-response events
 * (float milliseconds) into a 10 us histogram, because autocannon's own histogram rounds to whole
 * milliseconds, which is useless for a route that answers in under one.
 *
 * `rate` (requests per second, all connections together) is optional. With it, latencies are not
 * corrected for coordinated omission; without it, the load is closed-loop at `connections`.
 */
export async function load({
  port,
  paths,
  duration,
  connections = 64,
  rate,
  onTick,
}) {
  const bins = new Uint32Array(MAX_BINS + 1);
  let total = 0;
  let sumMs = 0;
  let maxMs = 0;
  const instance = autocannon({
    url: `http://127.0.0.1:${port}`,
    connections,
    duration,
    pipelining: 1,
    overallRate: rate,
    requests: paths.map((path) => ({ method: "GET", path })),
  });
  instance.on("response", (_client, statusCode, _bytes, ms) => {
    if (statusCode < 200 || statusCode >= 300) return;
    total++;
    sumMs += ms;
    if (ms > maxMs) maxMs = ms;
    bins[Math.min(MAX_BINS, Math.floor((ms * 1000) / BIN_US))]++;
  });
  if (onTick) instance.on("tick", onTick);
  const result = await instance;
  const percentile = (p) => {
    if (total === 0) return Number.NaN;
    const target = Math.ceil((p / 100) * total);
    let seen = 0;
    for (let i = 0; i <= MAX_BINS; i++) {
      seen += bins[i];
      if (seen >= target) return ((i + 1) * BIN_US) / 1000;
    }
    return maxMs;
  };
  return {
    requests: total,
    requestsPerSec: round(total / result.duration, 1),
    seconds: result.duration,
    latencyMs: {
      mean: round(sumMs / Math.max(1, total), 3),
      p50: round(percentile(50), 3),
      p90: round(percentile(90), 3),
      p99: round(percentile(99), 3),
      p999: round(percentile(99.9), 3),
      max: round(maxMs, 3),
    },
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
  };
}

// ---------------------------------------------------------------------------------------------
// Configurations

/**
 * Upstream auto-instrumentation is installed on demand into node_modules/.cache/upstream, outside the
 * workspace, so its roughly 100 packages stay out of the lockfile and out of every other package's
 * peer resolution (adding it to the workspace changed @nestjs/microservices' resolution in other
 * packages). Loaded the documented way: `node --import <pkg>/register app.js`.
 */
export async function upstreamArgv() {
  const dir = join(benchDir, "node_modules", ".cache", "upstream");
  const pkg = "@opentelemetry/auto-instrumentations-node";
  const register = join(dir, "node_modules", pkg, "dist", "register.mjs");
  if (!existsSync(register)) {
    const version = (
      await execFileAsync("npm", ["view", pkg, "version"])
    ).stdout.trim();
    console.log(`installing ${pkg}@${version} into ${dir}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "upstream-probe", private: true }),
    );
    await execFileAsync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        `${pkg}@${version}`,
      ],
      { cwd: dir, timeout: 300_000 },
    );
  }
  if (!existsSync(register))
    throw new Error(`${register} not found after install`);
  return ["--import", pathToFileURL(register).href];
}

/** Which sink (if any) a configuration needs, and whether it loads Nestrix. */
export const CONFIGS = {
  baseline: { label: "uninstrumented", nestrix: false },
  interceptor: {
    label: "uninstrumented plus a no-op global interceptor",
    nestrix: false,
  },
  // `noexport` predates the dashboard: it is `forRoot()` with the default `ui: 'auto'`, which is on
  // when NODE_ENV is unset. Use `headless` and `dashboard` to compare with and without it.
  noexport: { label: "Nestrix, no endpoint (nothing exported)", nestrix: true },
  headless: {
    label: "Nestrix, dashboard off (ui: false), export off",
    nestrix: true,
    env: { NODE_ENV: "development" },
  },
  dashboard: {
    label: "Nestrix, dashboard on ('auto', NODE_ENV=development), export off",
    nestrix: true,
    env: { NODE_ENV: "development" },
  },
  // headless with the OTLP exporter module forced in at startup: the "before P2-14" cost.
  "headless-eager": {
    label: "headless plus an eager import of the OTLP exporter (before P2-14)",
    nestrix: true,
    env: { NODE_ENV: "development", BENCH_EAGER_EXPORTER: "1" },
  },
  sink: { label: "Nestrix, local OTLP sink", nestrix: true, sink: "sink" },
  unreachable: {
    label: "Nestrix, endpoint refuses connections",
    nestrix: true,
    sink: "closed",
  },
  blackhole: {
    label: "Nestrix, endpoint accepts and never answers",
    nestrix: true,
    sink: "blackhole",
  },
  upstream: {
    label: "upstream auto-instrumentation (OpenTelemetry Node)",
    nestrix: false,
    upstream: true,
  },
};

/**
 * Brings up whatever `config` needs (a sink process), starts the app against it and returns both.
 * `finish()` stops the app, then asks the sink what it received.
 */
export async function bringUp(config, { queueSize, execArgv } = {}) {
  const spec = CONFIGS[config];
  if (!spec) throw new Error(`unknown configuration "${config}"`);
  let sink;
  let endpoint;
  if (spec.sink === "sink" || spec.sink === "blackhole") {
    sink = await startSink(spec.sink);
    endpoint = sink.url;
  } else if (spec.sink === "closed") {
    endpoint = `http://127.0.0.1:${await closedPort()}`;
  } else if (spec.upstream) {
    // The upstream SDK needs a sink to talk to or it logs export errors; give it the real one.
    sink = await startSink("sink");
    endpoint = sink.url;
  }
  const app = await startApp({
    config,
    port: await closedPort(),
    endpoint,
    queueSize,
    execArgv: spec.upstream
      ? [...(await upstreamArgv()), ...(execArgv ?? [])]
      : execArgv,
    env: spec.upstream
      ? {
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_SERVICE_NAME: "bench-upstream",
          OTEL_METRICS_EXPORTER: "none",
          OTEL_LOGS_EXPORTER: "none",
        }
      : { ...spec.env },
  });
  return {
    app,
    sink,
    async finish() {
      const stderr = await app.stop();
      const sinkStats = sink ? await sink.stats() : undefined;
      if (sink) await sink.stop();
      return { stderr, sinkStats };
    },
  };
}
