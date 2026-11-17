import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/check-readme-status.mjs", import.meta.url),
);

function check(version: string, readme: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "readme-status-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", version }),
  );
  writeFileSync(join(dir, "README.md"), readme);
  try {
    return {
      code: 0,
      out: execFileSync("node", [script, dir], { encoding: "utf8" }),
    };
  } catch (error) {
    const e = error as { status: number; stderr: string };
    return { code: e.status, out: e.stderr };
  }
}

describe("check-readme-status", () => {
  it("fails on a status line that names another version", () => {
    const r = check("0.4.0", "# x\n\n> **Status: 0.1.0.** old\n");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /README.md:3: status line names version 0.1.0, but the package is 0.4.0/,
    );
  });

  it("passes with no version, or with the package's own version", () => {
    expect(check("0.4.0", "> **Status: pre-1.0.** fine\n").code).toBe(0);
    expect(check("0.4.0", "> **Status: 0.4.0.** fine\n").code).toBe(0);
  });

  it("ignores versions outside status lines", () => {
    expect(
      check("0.4.0", "> **Status: pre-1.0.**\n\nSize at 0.1.0 was small.\n")
        .code,
    ).toBe(0);
  });
});
