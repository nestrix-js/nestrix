import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { note } from "./helpers.js";

/**
 * Review item 5: an HttpAdapterHost.init$ subscriber that throws. Runs
 * scripts/init-subscriber-throws.mjs in a child process, because the error
 * escapes as an uncaught exception.
 */

const script = fileURLToPath(
  new URL("../scripts/init-subscriber-throws.mjs", import.meta.url),
);
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 20_000,
  });

describe("R4 a throwing init$ subscriber", () => {
  for (const mode of ["factory", "testing"]) {
    it(`${mode}: boot completes, the error surfaces as uncaughtException`, () => {
      const r = run(mode);
      const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
      note(`R4 init$ throw ${mode}`, out);
      expect(r.status).toBe(0);
      expect(out.boot).toBe("ok");
      expect(out.events).toEqual(["uncaughtException: init$ subscriber threw"]);
    });
  }

  it("factory, no uncaughtException handler: the process dies", () => {
    const r = run("factory", "nohandler");
    note("R4 init$ throw no handler", {
      status: r.status,
      stderr: r.stderr.split("\n").find((l) => l.includes("init$ subscriber")),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/init\$ subscriber threw/);
  });
});
