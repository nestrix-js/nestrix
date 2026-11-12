// Every tool against a real embedded dashboard: a Nest app in a child process with
// `NestrixModule.forRoot({ ui: { enabled: true, auth: { token } } })` (test/fixtures/app.mjs),
// which needs `pnpm build` of @nestrix-js/nestjs first.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Connected, connect } from "./helpers.js";

const APP = fileURLToPath(new URL("./fixtures/app.mjs", import.meta.url));
const TOKEN = "e".repeat(40);
const HOT_LINE =
  readFileSync(APP, "utf8")
    .split("\n")
    .findIndex((l) => l.startsWith("export function hotRouteWork")) + 1;

let child: ChildProcess;
let app: string;
let mcp: Connected;

async function startApp(): Promise<string> {
  const c = spawn(process.execPath, [APP], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, APP_DASHBOARD_TOKEN: TOKEN },
  });
  child = c;
  let stderr = "";
  c.stderr?.on("data", (d: Buffer) => {
    stderr += d;
  });
  const lines = createInterface({ input: c.stdout as NodeJS.ReadableStream });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`app did not start: ${stderr}`)),
      20_000,
    );
    c.once("exit", (code) =>
      reject(new Error(`app exited (${code}): ${stderr}`)),
    );
    lines.on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as { port?: number };
        if (typeof parsed.port === "number") {
          clearTimeout(timer);
          resolve(parsed.port);
        }
      } catch {
        // Not our line.
      }
    });
  });
  return `http://127.0.0.1:${port}`;
}

const hit = async (path: string): Promise<number> =>
  (await fetch(`${app}${path}`)).status;

beforeAll(async () => {
  app = await startApp();
  for (let i = 0; i < 3; i++) expect(await hit("/orders")).toBe(200);
  for (let i = 0; i < 2; i++) expect(await hit("/boom")).toBe(500);
  expect(await hit("/hello")).toBe(200);
  for (let i = 0; i < 20; i++) await hit("/cpu");
  mcp = await connect(
    { url: `${app}/_nestrix`, token: TOKEN, timeoutMs: 10_000 },
    { pollIntervalMs: 200 },
  );
});

afterAll(async () => {
  await mcp?.close();
  const c = child;
  if (c && c.exitCode === null) {
    c.send("close");
    const exited = new Promise((r) => c.once("exit", r));
    const timer = setTimeout(() => c.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  }
});

const traceIdIn = (text: string): string => {
  const found = /\b[0-9a-f]{32}\b/.exec(text)?.[0];
  if (!found) throw new Error(`no trace id in: ${text}`);
  return found;
};

describe("embedded dashboard", () => {
  it("overview names the app, its routes and the available profiler", async () => {
    const out = await mcp.call("overview");
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain(
      "dashboard (embedded in one app): mcp-embedded-fixture",
    );
    expect(out.text).toContain("CPU profiler: available (start_profile)");
    expect(out.text).toContain("GET /orders");
    expect(out.text).toMatch(/GET \/boom: 2\/2 failed \(100%\)/);
  });

  it("find_traces finds the orders traces; filters narrow the list", async () => {
    const all = await mcp.call("find_traces", { route: "/orders" });
    expect(all.isError, all.text).toBe(false);
    expect(all.text).toContain("3 traces");
    const slow = await mcp.call("find_traces", {
      minDurationMs: 50,
      status: "ok",
    });
    expect(slow.text).toContain("GET /orders");
    expect(slow.text).not.toContain("GET /hello");
    const failed = await mcp.call("find_traces", { status: "error" });
    expect(failed.text).toContain("GET /boom");
    expect(failed.text).not.toContain("GET /orders");
  });

  it("get_trace on the N+1 route names the repeated statement and its count", async () => {
    const list = await mcp.call("find_traces", { route: "/orders", limit: 1 });
    const out = await mcp.call("get_trace", { traceId: traceIdIn(list.text) });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain("Repeated statements (possible N+1):");
    expect(out.text).toContain("- 5x SELECT * FROM users WHERE id = $1");
    expect(out.text).toMatch(/SELECT orders \[client\] [\d.]+ms <SLOW>/);
    expect(out.text).toContain("Span tree");
  });

  it("list_errors groups the failures and get_trace shows the message and frames", async () => {
    const errors = await mcp.call("list_errors");
    expect(errors.isError, errors.text).toBe(false);
    expect(errors.text).toContain("kaboom from the fixture");
    expect(errors.text).toContain("2x");
    const out = await mcp.call("get_trace", {
      traceId: traceIdIn(errors.text),
    });
    expect(out.text).toContain("Errors (");
    expect(out.text).toContain("kaboom from the fixture");
    expect(out.text).toMatch(/\n {4}at /);
    expect(out.text.match(/\n {4}at /g)?.length).toBeLessThanOrEqual(3 * 2);
  });

  it("route_stats, class_stats and app_map answer", async () => {
    const stats = await mcp.call("route_stats");
    expect(stats.isError, stats.text).toBe(false);
    expect(stats.text).toContain("GET /orders");
    expect(stats.text).toContain("Every request is counted");
    const stats60 = await mcp.call("route_stats", { windowMinutes: 60 });
    expect(stats60.text).toContain("last 60 minutes");
    const cls = await mcp.call("class_stats");
    expect(cls.isError, cls.text).toBe(false);
    expect(cls.text.length).toBeGreaterThan(20);
    const map = await mcp.call("app_map");
    expect(map.isError, map.text).toBe(false);
    expect(map.text).toContain("postgresql");
  });

  it("explain_slowness ranks the slowest span name first and flags the N+1", async () => {
    const out = await mcp.call("explain_slowness", { route: "/orders" });
    expect(out.isError, out.text).toBe(false);
    const ranked = out.text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(ranked[0]).toMatch(/^1\. SELECT orders \[db\]/);
    expect(out.text).toContain(
      "5x SELECT * FROM users WHERE id = $1".replace("5x", "15x"),
    );
    expect(out.text).toContain("N+1 suspect");
  });

  it("a wrong token is told to check NESTRIX_TOKEN (the dashboard answers 404 to it)", async () => {
    const bad = await connect({
      url: `${app}/_nestrix`,
      token: "z".repeat(40),
      timeoutMs: 5000,
    });
    const out = await bad.call("overview");
    await bad.close();
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not a Nestrix dashboard or server");
    expect(out.text).toContain("wrong NESTRIX_TOKEN");
    expect(out.text).not.toContain("z".repeat(40));
  });

  it("a wrong base path is told it is not a Nestrix dashboard", async () => {
    const bad = await connect({
      url: `${app}/nothing-here`,
      token: TOKEN,
      timeoutMs: 5000,
    });
    const out = await bad.call("route_stats");
    await bad.close();
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Not found");
  });

  it("start_profile: refuses a second capture while one runs, returns the hot function, then honours the cool-down", async () => {
    let load = true;
    const loader = (async () => {
      while (load) await hit("/cpu").catch(() => 0);
    })();
    try {
      const first = mcp.call("start_profile", { durationSeconds: 3 });
      await new Promise((r) => setTimeout(r, 600));
      const second = await mcp.call("start_profile", { durationSeconds: 1 });
      expect(second.isError).toBe(true);
      expect(second.text).toContain("already running");

      const out = await first;
      expect(out.isError, out.text).toBe(false);
      expect(out.text).toContain("CPU profile ");
      expect(out.text).toContain("starting it paused the app for");
      const top = out.text.split("\n").find((l) => /^1\. /.test(l)) ?? "";
      expect(top).toContain("hotRouteWork");
      expect(top).toContain(`app.mjs:${HOT_LINE}`);

      const again = await mcp.call("start_profile", { durationSeconds: 1 });
      expect(again.isError).toBe(true);
      expect(again.text).toMatch(
        /ended less than 10 seconds ago\. Try again in \d+ s/,
      );
    } finally {
      load = false;
      await loader;
    }
  });
});
