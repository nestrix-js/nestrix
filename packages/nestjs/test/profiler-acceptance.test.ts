// P7-02 acceptance (docs/backlog/phase-7.md): a capture started through the dashboard's API on
// each adapter returns a valid `.cpuprofile`, shows the hot function of a CPU-bound route at the
// top, and leaves the app's responses unchanged.
//
// As P7-S1 advises: the app runs in a fresh child process per adapter (test/fixtures/
// profiler-app.mjs, on the built package, so `pnpm build` must have run), the route is warmed
// before the one capture, and the function is looked up by name.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTERS, get } from "./dashboard-fixture.js";
import { rawRequest } from "./dashboard-security-fixture.js";

const APP = fileURLToPath(
  new URL("./fixtures/profiler-app.mjs", import.meta.url),
);
const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const TOKEN = "p".repeat(40);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const PROFILES = "/_nestrix/api/v1/profiles";
/** 1-based line of `hotRouteWork` in the fixture. */
const HOT_LINE =
  readFileSync(APP, "utf8")
    .split("\n")
    .findIndex((l) => l.startsWith("export function hotRouteWork")) + 1;

let child: ChildProcess | undefined;

afterEach(async () => {
  const c = child;
  child = undefined;
  if (c && c.exitCode === null) {
    c.send("close");
    const exited = new Promise((r) => c.once("exit", r));
    const timer = setTimeout(() => c.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  }
});

async function startApp(adapter: string): Promise<string> {
  try {
    readFileSync(DIST);
  } catch {
    throw new Error(
      "packages/nestjs/dist is missing: run `pnpm build` before this test.",
    );
  }
  const c = spawn(process.execPath, [APP, adapter], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
      15_000,
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
  return `127.0.0.1:${port}`;
}

/** What the dashboard page's fetch sends to start a capture. */
function startCapture(host: string, durationSeconds: number) {
  const body = JSON.stringify({ durationSeconds });
  const port = Number(host.split(":")[1]);
  return rawRequest(
    port,
    [
      `POST ${PROFILES} HTTP/1.1`,
      `Host: ${host}`,
      `Origin: http://${host}`,
      "Sec-Fetch-Site: same-origin",
      "Content-Type: application/json",
      `Authorization: Bearer ${TOKEN}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
}

interface CpuProfile {
  nodes: {
    id: number;
    callFrame: {
      functionName: string;
      scriptId: unknown;
      url: string;
      lineNumber: number;
    };
    children?: number[];
  }[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/** The structural checks of spikes/p7-s1/fixtures/validate.mjs. Empty when valid. */
function problems(p: CpuProfile): string[] {
  const out: string[] = [];
  for (const key of [
    "nodes",
    "startTime",
    "endTime",
    "samples",
    "timeDeltas",
  ]) {
    if (!(key in p)) out.push(`missing ${key}`);
  }
  if (p.samples.length !== p.timeDeltas.length)
    out.push("samples and timeDeltas differ in length");
  const ids = new Set(p.nodes.map((n) => n.id));
  if (!p.samples.every((s) => ids.has(s))) out.push("a sample is not a node");
  for (const n of p.nodes) {
    for (const c of n.children ?? [])
      if (!ids.has(c)) out.push(`child ${c} is not a node`);
    if (typeof n.callFrame.scriptId !== "string")
      out.push(`scriptId of ${n.id} is not a string`);
    if (n.callFrame.url.startsWith("/"))
      out.push(`url of ${n.id} is a bare path`);
  }
  if (p.nodes[0]?.callFrame.functionName !== "(root)")
    out.push("first node is not (root)");
  const span = p.timeDeltas.reduce((a, b) => a + b, 0);
  if (span > p.endTime - p.startTime + 1000)
    out.push("time deltas exceed the profile span");
  return out;
}

describe.each(ADAPTERS)("profiler acceptance on %s", (adapter) => {
  it("captures through the API: valid .cpuprofile, hot function on top, responses unchanged", async () => {
    const host = await startApp(adapter);
    const base = `http://${host}`;
    const call = async (path: string) => {
      const r = await get(`${base}${path}`);
      return `${r.status} ${r.text}`;
    };
    const expected = await call("/cpu");
    expect(expected).toMatch(/^200 -?\d/);
    for (let i = 0; i < 50; i++) await call("/cpu");

    const started = await startCapture(host, 2);
    expect(started.status, started.body).toBe(202);
    const running = JSON.parse(started.body) as {
      id: string;
      startPauseMs: number;
    };
    expect(running.startPauseMs).toBeGreaterThan(0);

    const during = new Set<string>();
    const until = Date.now() + 2300;
    let i = 0;
    while (Date.now() < until)
      during.add(await call(i++ % 2 ? "/cpu" : "/hello"));
    expect([...during].sort()).toEqual([expected, "200 hello"].sort());

    let list: { profiles: { id: string; samples: number }[]; running: unknown };
    const deadline = Date.now() + 5000;
    do {
      list = (await get(`${base}${PROFILES}`, AUTH)).json() as typeof list;
      if (list.profiles.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    expect(list.running).toBeNull();
    expect(list.profiles.map((p) => p.id)).toEqual([running.id]);

    const detail = (
      await get(`${base}${PROFILES}/${running.id}`, AUTH)
    ).json() as {
      topFunctions: { functionName: string; url: string; line: number }[];
      flame: { totalSamples: number; children: unknown[] };
    };
    const own = detail.topFunctions.filter(
      (f) => !f.functionName.startsWith("("),
    );
    expect(
      own[0],
      JSON.stringify(detail.topFunctions.slice(0, 5)),
    ).toMatchObject({
      functionName: "hotRouteWork",
      line: HOT_LINE,
    });
    expect(own[0]?.url).toMatch(/^file:\/\/.*\/profiler-app\.mjs$/);
    expect(detail.flame.totalSamples).toBeGreaterThan(0);
    expect(detail.flame.children.length).toBeGreaterThan(0);

    const file = await get(`${base}${PROFILES}/${running.id}/download`, AUTH);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(
      new RegExp(
        `^attachment; filename="nestrix-[0-9T:Z-]+-${running.id}\\.cpuprofile"$`,
      ),
    );
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    const profile = file.json() as CpuProfile;
    expect(problems(profile)).toEqual([]);
    expect(profile.samples.length).toBe(list.profiles[0]?.samples);
    expect(
      profile.nodes.some(
        (n) =>
          n.callFrame.functionName === "hotRouteWork" &&
          n.callFrame.lineNumber === HOT_LINE - 1,
      ),
    ).toBe(true);

    expect(await call("/cpu")).toBe(expected);
  }, 30_000);
});
