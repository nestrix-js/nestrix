import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface SpanRecord {
  name: string;
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: string[];
  startMs: number;
  endMs: number;
}

export interface RunOutput<T> {
  code: number | null;
  stdout: string;
  stderr: string;
  result: T | undefined;
}

/** Runs `file` with a plain `node` (no flags) and parses the `<marker>{json}` line. */
export function runNode<T>(
  file: string,
  opts: {
    env?: Record<string, string | undefined>;
    node?: string;
    marker: string;
    cwd?: string;
    args?: string[];
    timeoutMs?: number;
  },
): Promise<RunOutput<T>> {
  const env: Record<string, string | undefined> = { ...process.env };
  // Nothing inherited from the test runner may act as a preload or widen resolution:
  // pnpm's bin shims (node_modules/.bin/vitest) export NODE_PATH, which includes the
  // hoisted node_modules/.pnpm/node_modules.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  for (const k of Object.keys(env)) {
    if (k.startsWith("VITEST") || k === "TINYPOOL_WORKER_ID") delete env[k];
  }
  Object.assign(env, opts.env);
  return new Promise((resolve) => {
    execFile(
      opts.node ?? process.execPath,
      [file, ...(opts.args ?? [])],
      {
        cwd: opts.cwd ?? spikeRoot,
        env: env as NodeJS.ProcessEnv,
        timeout: opts.timeoutMs ?? 90_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const line = stdout.split("\n").find((l) => l.startsWith(opts.marker));
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
          result: line
            ? (JSON.parse(line.slice(opts.marker.length)) as T)
            : undefined,
        });
      },
    );
  });
}

export interface DbUrls {
  pg?: string;
  mysql?: string;
  redis?: string;
}

function readDbFile(): DbUrls {
  const file = join(spikeRoot, ".db.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DbUrls;
  } catch {
    return {};
  }
}

function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  const u = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host: u.hostname, port: Number(u.port) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** DB URLs from env (PG_URL/MYSQL_URL/REDIS_URL) or .db.json, kept only if a TCP connect works. */
export async function availableDbs(): Promise<DbUrls> {
  const file = readDbFile();
  const urls: DbUrls = {
    pg: process.env.PG_URL ?? file.pg,
    mysql: process.env.MYSQL_URL ?? file.mysql,
    redis: process.env.REDIS_URL ?? file.redis,
  };
  const out: DbUrls = {};
  for (const key of ["pg", "mysql", "redis"] as const) {
    if (await reachable(urls[key])) out[key] = urls[key];
  }
  return out;
}

export const dbs = await availableDbs();

export function skipNote(what: string, ok: boolean): string {
  return ok
    ? what
    : `${what} [SKIPPED: not reachable; run \`pnpm --filter spike-p0-s2 db:up\`]`;
}

/** Node binaries for Q2: the running one, plus NODE_22 / NODE_24 or ./.node/<v>/bin/node. */
export function nodeBinaries(): Array<{ label: string; bin: string }> {
  const out = [{ label: process.version, bin: process.execPath }];
  for (const [envName, version] of [
    ["NODE_22", "22.15.0"],
    ["NODE_24", "24.22.2"],
  ] as const) {
    const local = join(
      spikeRoot,
      ".node",
      `node-v${version}-${process.platform}-${process.arch}`,
      "bin",
      "node",
    );
    const bin = process.env[envName] ?? (existsSync(local) ? local : undefined);
    if (bin && existsSync(bin)) out.push({ label: `v${version}`, bin });
  }
  return out;
}

export function requireBuilt(): void {
  for (const f of [
    "dist/src/fixture/main.js",
    "cjs/dist/main.js",
    "dist/src/q7/behaviour.js",
  ]) {
    if (!existsSync(join(spikeRoot, f))) {
      throw new Error(
        `${f} missing: run \`pnpm --filter spike-p0-s2 build\` first`,
      );
    }
  }
}

export interface FixtureResult {
  format: "esm" | "cjs";
  adapter?: string;
  node: string;
  execArgv: string[];
  nodeOptions: string;
  enable: {
    tracing: Record<string, boolean>;
    undici: { enabled: boolean; requireHookInstalled: boolean };
    pg: { enabled: boolean; resolvedFrom?: string; version?: string };
  };
  responses: Record<string, { status: number; body: unknown }>;
  received: Array<{ path: string; traceparent?: string }>;
  spans: SpanRecord[];
  failures: Record<string, number>;
  httpChannelsSeen: Record<string, number>;
}

export function runFixture(
  format: "esm" | "cjs",
  scenarios: string[],
  opts: { node?: string; env?: Record<string, string | undefined> } = {},
) {
  const file =
    format === "esm"
      ? join(spikeRoot, "dist/src/fixture/main.js")
      : join(spikeRoot, "cjs/dist/main.js");
  return runNode<FixtureResult>(file, {
    marker: "__P0S2_RESULT__",
    node: opts.node,
    env: {
      SCENARIOS: scenarios.join(","),
      PG_URL: dbs.pg,
      MYSQL_URL: dbs.mysql,
      REDIS_URL: dbs.redis,
      ...opts.env,
    },
  });
}

export const childrenOf = (spans: SpanRecord[], parent: string) =>
  spans.filter((s) => s.parentSpanId === parent);

export const SPAN_KIND_CLIENT = 2;
export const STATUS_ERROR = 2;
