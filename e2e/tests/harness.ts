import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";

export type Adapter = "express" | "fastify" | "node";

/** Built entry points of the apps (e2e/apps, e2e/apps-cjs): each is an example app plus NestrixModule. */
const entries = {
  express: "../dist/express-esm.js",
  fastify: "../dist/fastify-esm.js",
  node: "../dist/node-esm.js",
  "express-cjs": "../apps-cjs/dist/main.js",
} as const;
export type Entry = keyof typeof entries;

export interface AppOptions {
  entry: Entry;
  /** E2E_PREFIX: global prefix. */
  prefix?: string;
  securityHeaders?: boolean;
  cors?: boolean;
  sampleRate?: number;
  catchAll?: boolean;
  /** Default `development`, the only value that opens `ui: 'auto'`. */
  nodeEnv?: string;
  /** False when the app is expected not to log a dashboard link. */
  expectLink?: boolean;
}

export interface App {
  pid: number | undefined;
  port: number;
  /** `http://127.0.0.1:<port>`, for requests to the app's own routes. */
  base: string;
  /** The routes' prefix: `""` or `"/api"`. */
  prefix: string;
  /** The startup link from the log (`http://localhost:<port>/_nestrix/auth?token=...`). */
  link: string;
  /** Everything the app wrote to stdout and stderr, without colour codes. */
  logs(): string;
  stop(): Promise<void>;
}

const running = new Set<ChildProcess>();
// Last resort if the runner dies mid-test: kill exactly the processes this file started.
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const linkPattern =
  /Nestrix dashboard: (http:\/\/localhost:\d+\S*\/auth\?token=\S+)/;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startApp(options: AppOptions): Promise<App> {
  const port = await freePort();
  const prefix = options.prefix ? `/${options.prefix}` : "";
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    NODE_ENV: options.nodeEnv ?? "development",
    // The /out route calls this app's own /hello, which gives a trace with client spans.
    OUT_URL: `http://127.0.0.1:${port}${prefix}/hello`,
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith("E2E_")) delete env[name];
  }
  if (options.prefix) env.E2E_PREFIX = options.prefix;
  if (options.securityHeaders) env.E2E_SECURITY_HEADERS = "1";
  if (options.cors) env.E2E_CORS = "1";
  if (options.sampleRate !== undefined)
    env.E2E_SAMPLE_RATE = String(options.sampleRate);
  if (options.catchAll) env.E2E_CATCH_ALL = "1";

  const entry = fileURLToPath(new URL(entries[options.entry], import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  let output = "";
  let exited = false;
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("exit", () => {
    exited = true;
    running.delete(child);
  });
  const logs = () => output.replace(ansi, "");

  const stop = async (): Promise<void> => {
    if (exited) return;
    const done = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await done;
    clearTimeout(killer);
  };

  const base = `http://127.0.0.1:${port}`;
  let link = "";
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (exited) throw new Error(`app exited before it was ready:\n${logs()}`);
      if (Date.now() > deadline)
        throw new Error(`app not ready within 30 s:\n${logs()}`);
      const match = linkPattern.exec(logs());
      if (match) {
        link = match[1] as string;
        break;
      }
      if (options.expectLink === false) {
        try {
          await fetch(`${base}${prefix}/hello`);
          break;
        } catch {
          // not listening yet
        }
      }
      await sleep(50);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { pid: child.pid, port, base, prefix, link, logs, stop };
}

export const test = base.extend<{
  boot: (options: AppOptions) => Promise<App>;
}>({
  // Every app a test boots is stopped when the test ends, pass or fail.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function uses from a destructured first argument
  boot: async ({}, use) => {
    const apps: App[] = [];
    try {
      await use(async (options) => {
        const app = await startApp(options);
        apps.push(app);
        return app;
      });
    } finally {
      await Promise.all(apps.map((app) => app.stop()));
    }
  },
});

export interface Watch {
  /** CSP violations, console errors, page errors, failed requests and HTTP errors seen so far. */
  problems: string[];
  /** Responses the page received from the dashboard, for header checks. */
  responses: { url: string; status: number; headers: Record<string, string> }[];
}

/** Collect everything that must stay empty. Call before the first `goto`. */
export async function watch(page: Page): Promise<Watch> {
  const w: Watch = { problems: [], responses: [] };
  // Registered before any page script runs, so no violation can be missed.
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(
        `CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"}`,
      );
    });
  });
  page.on("console", (m) => {
    if (m.type() === "error") w.problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => w.problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) =>
    w.problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    w.responses.push({
      url: r.url(),
      status: r.status(),
      headers: r.headers(),
    });
    if (r.status() >= 400) w.problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return w;
}

export function noAccessControlHeaders(w: Watch): string[] {
  return w.responses.flatMap((r) =>
    Object.keys(r.headers)
      .filter((h) => h.startsWith("access-control-"))
      .map((h) => `${r.url}: ${h}`),
  );
}

/** Requests to the app's own routes, as a client (not the browser). */
export async function send(
  app: App,
  path: string,
  times = 1,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await fetch(`${app.base}${app.prefix}${path}`);
    await res.arrayBuffer();
    statuses.push(res.status);
  }
  return statuses;
}

export { expect };
