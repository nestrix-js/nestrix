import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const scenario = (name: string) => join(SPIKE_DIR, "scenarios", name);
/** Node binary for scenario processes: `S3_NODE=/path/to/node` runs them on another version. */
export const NODE = process.env.S3_NODE || process.execPath;

export interface SpanRec {
  name: string;
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  scope?: string;
  attributes: Record<string, unknown>;
  status?: number;
}

export interface Running {
  port: number;
  base: string;
  get: (path: string, headers?: Record<string, string>) => Promise<Res>;
  finish: () => Promise<{ result: any; stdout: string; stderr: string }>;
  child: ChildProcess;
}

export interface Res {
  status: number;
  body: string;
}

/** Plain node:http client in the (uninstrumented) test process. */
export function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<Res>((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

/**
 * Starts a scenario in its own Node process (OpenTelemetry and Sentry globals are per
 * process), waits for `READY {"port":N}`, and returns a handle. `finish()` sends
 * FINISH on stdin and resolves with the parsed `RESULT {...}` line.
 */
export function startScenario(
  file: string,
  env: Record<string, string | undefined> = {},
  nodeArgs: string[] = [],
): Promise<Running> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [...nodeArgs, file], {
      cwd: SPIKE_DIR,
      env: { ...process.env, NODE_OPTIONS: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(`scenario ${file} not ready in 20s\n${stdout}\n${stderr}`),
      );
    }, 20_000);
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const exited = new Promise<number | null>((r) => child.on("exit", r));
    child.stdout.on("data", (d) => {
      stdout += d;
      const m = stdout.match(/READY (\{.*\})\n/);
      if (m && !ready) {
        ready = true;
        clearTimeout(timer);
        const { port } = JSON.parse(m[1]);
        const base = `http://127.0.0.1:${port}`;
        resolve({
          port,
          base,
          child,
          get: (path, headers) => get(base + path, headers),
          finish: async () => {
            child.stdin.write("FINISH\n");
            const code = await exited;
            const r = stdout.match(/RESULT (.*)\n/);
            if (code !== 0 || !r) {
              throw new Error(
                `scenario exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
              );
            }
            return { result: JSON.parse(r[1]), stdout, stderr };
          },
        });
      }
    });
    child.on("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(
          new Error(
            `scenario exited ${code} before READY\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A local HTTP server that records every request and answers 200. */
export async function startRecorder(): Promise<{
  url: string;
  port: number;
  requests: Recorded[];
  close: () => Promise<void>;
}> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Parses a Sentry envelope (newline-delimited JSON: header, then item header + payload pairs). */
export function parseEnvelope(raw: Buffer, encoding?: string): any[] {
  const text = (encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const items: any[] = [];
  for (let i = 1; i < lines.length; i += 2) {
    const header = JSON.parse(lines[i]);
    let payload: unknown;
    try {
      payload = JSON.parse(lines[i + 1] ?? "null");
    } catch {
      payload = lines[i + 1];
    }
    items.push({ header, payload });
  }
  return items;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const byName = (spans: SpanRec[], name: string) =>
  spans.filter((s) => s.name === name);
export const one = (spans: SpanRec[], name: string) => {
  const found = byName(spans, name);
  if (found.length !== 1) {
    throw new Error(
      `expected one span "${name}", got ${found.length}: ${spans.map((s) => s.name).join(", ")}`,
    );
  }
  return found[0];
};
