// Global state: an ALS context manager (for the in-request case), no provider.
// Process-level errors (P1-07): Nestrix adds an `uncaughtExceptionMonitor` listener only, so an
// unhandled rejection or uncaught exception still terminates the process exactly as without it.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import {
  faultInjection,
  REQUEST_STATE_KEY,
  type RequestState,
} from "../src/http/request-state.js";
import {
  installProcessErrorMonitor,
  onUncaughtExceptionMonitor,
} from "../src/process-errors.js";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const child = join(here, "fixtures", "process-error-child.mjs");

beforeAll(() => {
  // The child loads the built package; `tsc -b` is a no-op when dist is current.
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-b", join(pkg, "tsconfig.json")], {
    stdio: "pipe",
  });
}, 120_000);
beforeEach(() => resetDiagnosticsForTests());

function run(mode: string, withNestrix: boolean) {
  const result = spawnSync(process.execPath, [child, mode], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_NESTRIX: withNestrix ? "0" : "1" },
  });
  const counts = JSON.parse(result.stdout.split("\n")[0] ?? "{}") as Record<
    string,
    number
  >;
  return {
    status: result.status,
    signal: result.signal,
    counts,
    alive: result.stdout.includes("STILL ALIVE"),
    stderr: result.stderr,
  };
}

describe("child process with Nestrix loaded", () => {
  it("adds exactly one uncaughtExceptionMonitor and no other process error listener", () => {
    const control = run("none", false);
    const nestrix = run("none", true);
    expect(nestrix.counts).toEqual({
      ...control.counts,
      uncaughtExceptionMonitor: control.counts.uncaughtExceptionMonitor + 1,
    });
    expect(nestrix.alive).toBe(true);
  });

  it.each(["rejection", "throw"])(
    "a %s still terminates the process, as without Nestrix",
    (mode) => {
      const control = run(mode, false);
      const nestrix = run(mode, true);
      expect(control.alive).toBe(false);
      expect(nestrix.alive).toBe(false);
      expect(nestrix.status).toBe(control.status);
      expect(nestrix.status).toBe(1);
      expect(nestrix.signal).toBe(control.signal);
      expect(nestrix.stderr).toContain(
        mode === "rejection" ? "unhandled in child" : "uncaught in child",
      );
    },
    60_000,
  );
});

describe("the monitor (in process, called directly)", () => {
  function fakeState(): RequestState & { recorded: unknown[] } {
    const recorded: unknown[] = [];
    return {
      recorded,
      span: { recordException: (e: unknown) => recorded.push(e) } as never,
      method: "GET",
      baseName: "GET",
      route: undefined,
      reached: true,
      exception: undefined,
      ended: false,
    };
  }

  it("records on Nestrix's server span when the error surfaces inside a traced request", () => {
    const state = fakeState();
    const error = new TypeError("in request");
    context.with(ROOT_CONTEXT.setValue(REQUEST_STATE_KEY, state), () =>
      onUncaughtExceptionMonitor(error, "uncaughtException"),
    );
    expect(state.recorded).toEqual([error]);
    expect(state.exception).toEqual({ status: 500, type: "TypeError" });
  });

  it("never throws: an injected fault, or a value that cannot be printed", () => {
    faultInjection.site = "process-monitor";
    expect(() =>
      onUncaughtExceptionMonitor(new Error("x"), "uncaughtException"),
    ).not.toThrow();
    faultInjection.site = undefined;
    expect(getFailureCounts().get("process.uncaught-exception-monitor")).toBe(
      1,
    );
    const unprintable = Object.create(null, {
      toString: {
        value: () => {
          throw new Error("no");
        },
      },
    });
    expect(() =>
      onUncaughtExceptionMonitor(unprintable, "unhandledRejection"),
    ).not.toThrow();
  });

  it("is added once for several apps and removed with the last", () => {
    const on = vi.spyOn(process, "on");
    const off = vi.spyOn(process, "off");
    const before = process.listenerCount("uncaughtExceptionMonitor");
    const a = installProcessErrorMonitor();
    const b = installProcessErrorMonitor();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before + 1);
    a();
    a(); // idempotent
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before + 1);
    b();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before);
    expect(on.mock.calls.map((c) => c[0])).toEqual([
      "uncaughtExceptionMonitor",
    ]);
    expect(off.mock.calls.map((c) => c[0])).toEqual([
      "uncaughtExceptionMonitor",
    ]);
    vi.restoreAllMocks();
  });
});
