// With no `pg` resolvable and none loaded, the pg integration reports itself disabled and changes
// nothing (backlog P3-01 item 7). Runs in a child process with NODE_PATH removed: pnpm's bin shims
// export a NODE_PATH that reaches every hoisted package (P0-S2), and Vitest runs under one, so an
// in-process check would find the workspace's `pg`. Resolution starts from an empty temporary
// directory, as for an app that does not have `pg`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "nestrix-no-pg-"));
const from = join(dir, "from.js");
writeFileSync(from, "");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pg absent", () => {
  it("reports MODULE_NOT_FOUND, wraps nothing, counts no failure", () => {
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        join(here, "../fixtures/ts-hooks.mjs"),
        join(here, "fixtures/pg-absent-child.mjs"),
        from,
      ],
      { env, encoding: "utf8", timeout: 20_000 },
    );
    expect(JSON.parse(out)).toEqual({
      status: { enabled: false, reason: "MODULE_NOT_FOUND", modules: [] },
      failures: [],
      pgInCache: [],
    });
  });
});
