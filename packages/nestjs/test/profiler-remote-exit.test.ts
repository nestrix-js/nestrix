// P10-01: after `app.close()` the process exits promptly, whatever the poller was doing: a check-in
// hanging on the server, idle keep-alive sockets after normal check-ins, or a capture running.
// Runs test/fixtures/remote-profiler-child.mjs on the built package (`pnpm build` first).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_IN,
  type FakeServer,
  startFakeServer,
} from "./profiler-remote-fixture.js";

const CHILD = fileURLToPath(
  new URL("./fixtures/remote-profiler-child.mjs", import.meta.url),
);
const NOCLOSE_CHILD = fileURLToPath(
  new URL("./fixtures/remote-profiler-noclose-child.mjs", import.meta.url),
);
const DIST = fileURLToPath(
  new URL("../dist/profiler/remote.js", import.meta.url),
);

let server: FakeServer;
beforeAll(async () => {
  if (!existsSync(DIST)) {
    throw new Error(
      "packages/nestjs/dist is missing or stale: run `pnpm build` before this test.",
    );
  }
  server = await startFakeServer();
});
afterAll(async () => {
  await server.close();
});

async function runChild(waitMs: number, script = CHILD) {
  const child = spawn(
    process.execPath,
    ["--no-warnings", script, server.url, String(waitMs)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let printedAt = 0;
  child.stdout.on("data", (c: Buffer) => {
    stdout += c;
    printedAt ||= Date.now();
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr += c;
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return {
    code,
    stderr,
    result: stdout ? JSON.parse(stdout) : undefined,
    lingerMs: printedAt ? Date.now() - printedAt : Number.NaN,
  };
}

describe("the process exits after app.close()", () => {
  it("with a check-in hanging on the server", async () => {
    server.hits.length = 0;
    server.aborted = 0;
    server.respond = (hit) =>
      hit.path === CHECK_IN ? "hang" : { status: 200, json: {} };
    const run = await runChild(300);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(server.checkIns()).toHaveLength(1);
    expect(run.lingerMs).toBeLessThan(1000);
    // The hanging request was aborted by stop(), not left to its 5 s timeout.
    expect(server.aborted).toBe(1);
  }, 20_000);

  it("after normal check-ins (idle keep-alive sockets)", async () => {
    server.hits.length = 0;
    server.respond = (hit) =>
      hit.path === CHECK_IN
        ? { status: 200, json: { nextCheckInMs: 20 } }
        : { status: 200, json: {} };
    const run = await runChild(300);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(server.checkIns().length).toBeGreaterThan(2);
    expect(run.lingerMs).toBeLessThan(1000);
  }, 20_000);

  it("with an ordered capture running: discarded, nothing uploaded", async () => {
    server.hits.length = 0;
    let sent = false;
    server.respond = (hit) => {
      if (hit.path === CHECK_IN) {
        const capture = sent
          ? undefined
          : { id: "cccccccccccccccc", durationMs: 60_000 };
        sent = true;
        return { status: 200, json: { capture, nextCheckInMs: 20 } };
      }
      return { status: 200, json: {} };
    };
    const run = await runChild(400);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.result.capturing).toBe(true);
    expect(run.result.stillCapturing).toBe(false);
    expect(run.lingerMs).toBeLessThan(1000);
    expect(
      server.hits.some((h) => h.path.startsWith("/v1/nestrix/profiles")),
    ).toBe(false);
  }, 20_000);
});

describe("the process exits without app.close()", () => {
  it("with a check-in in flight to a server that never answers", async () => {
    server.hits.length = 0;
    server.respond = () => "hang";
    const run = await runChild(300, NOCLOSE_CHILD);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // The request was really in flight when the host finished its work.
    expect(server.checkIns()).toHaveLength(1);
    expect(run.lingerMs).toBeLessThan(1000);
  }, 20_000);
});
