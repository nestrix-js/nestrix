// Global state: Nestrix owns the provider; the collector accepts connections and never
// answers. Shutdown must resolve near its bound, and a process must be free to exit right
// after it (exporter retries, its socket and the batch processor's export timer must not
// hold it).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTelemetry } from "../src/otel/setup.js";
import {
  config,
  otlp,
  recordingDiagnostics,
  unreachableUrl,
} from "./otel-helpers.js";

let hanging: Server;
let hangingUrl: string;
/** Open sockets from the exporter. (`IncomingMessage` emits `close` once its body is read, so requests cannot be counted that way.) */
let openSockets = 0;

beforeAll(async () => {
  hanging = createServer((req) => {
    req.resume();
  });
  hanging.on("connection", (socket) => {
    openSockets++;
    socket.on("close", () => openSockets--);
  });
  hanging.listen(0, "127.0.0.1");
  await once(hanging, "listening");
  hangingUrl = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/v1/traces`;
});
afterAll(async () => {
  hanging.closeAllConnections();
  hanging.close();
  await once(hanging, "close");
});

const BOUND = 800;
const EXPORTER_TIMEOUT = 20_000;

describe("shutdown bound", () => {
  it("resolves near the bound, fails the in-flight export, and closes the exporter's socket", async () => {
    const diagnostics = recordingDiagnostics();
    const handle = setupTelemetry(
      config({
        export: {
          otlp: otlp(hangingUrl, EXPORTER_TIMEOUT),
          queue: {
            maxQueueSize: 100,
            maxExportBatchSize: 10,
            scheduledDelayMillis: 10,
          },
        },
        shutdownTimeoutMillis: BOUND,
      }),
      diagnostics,
    );
    for (let i = 0; i < 25; i++) trace.getTracer("b").startSpan(`s${i}`).end();
    await expect.poll(() => openSockets).toBeGreaterThan(0);

    const started = Date.now();
    await handle.shutdown();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(BOUND - 50);
    expect(took).toBeLessThan(BOUND + 400);
    expect(handle.counters.exportFailedSpans).toBe(25);
    expect(handle.counters.exportedSpans).toBe(0);
    expect(diagnostics.logs.has("otel.shutdown-timeout")).toBe(true);
    // abort() destroyed the socket instead of leaving the request to its 20 s timeout.
    await expect.poll(() => openSockets, { timeout: 1000 }).toBe(0);
    expect(diagnostics.failures).toEqual([]);
  });
});

/** Runs test/fixtures/otel-exit-child.mjs (src/*.ts through Node's type stripping). */
async function runChild(url: string) {
  const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const strip = (process.features as { typescript?: unknown }).typescript
    ? []
    : ["--experimental-strip-types"];
  const child = spawn(
    process.execPath,
    [
      ...strip,
      "--no-warnings",
      "--import",
      `${fixtures}ts-hooks.mjs`,
      `${fixtures}otel-exit-child.mjs`,
      url,
      String(EXPORTER_TIMEOUT),
      String(BOUND),
    ],
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
  const exitedAt = Date.now();
  return {
    code,
    stderr,
    result: stdout ? JSON.parse(stdout) : undefined,
    lingerMs: printedAt ? exitedAt - printedAt : Number.NaN,
  };
}

describe("a process exits after shutdown", () => {
  it("collector hangs: exits promptly after shutdown resolves", async () => {
    const run = await runChild(hangingUrl);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.result.shutdownMs).toBeLessThan(BOUND + 400);
    expect(run.result.counters.exportFailedSpans).toBe(25);
    // Before the fix this was the exporter's timeout (20 s here).
    expect(run.lingerMs).toBeLessThan(1000);
  }, 30_000);

  it("collector refuses: exits after at most one exporter retry backoff (capped at 5 s)", async () => {
    const run = await runChild(await unreachableUrl());
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.result.shutdownMs).toBeLessThan(BOUND + 400);
    // A retry already scheduled by the exporter cannot be cancelled through public API;
    // its next attempt fails at once with a non-retryable error.
    expect(run.lingerMs).toBeLessThan(5000 + 1000);
  }, 30_000);
});
