// Runs a probe in its own Node process (profilers are per process, and the probes need real file
// URLs, which code transformed by Vitest does not have) and returns its JSON lines.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function probe(
  name: string,
  args: string[] = [],
  opts: { env?: Record<string, string>; execArgv?: string[] } = {},
): Promise<Record<string, unknown>[]> {
  const file = fileURLToPath(new URL(`../probes/${name}`, import.meta.url));
  const { stdout } = await run(
    process.execPath,
    [...(opts.execArgv ?? []), file, ...args],
    {
      env: { ...process.env, ...opts.env },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
}

// biome-ignore lint/suspicious/noExplicitAny: probe output is checked field by field
export type Row = Record<string, any>;

/** 0-based line of `export function hotRouteWork` in fixtures/app.mjs, as a .cpuprofile reports it. */
export const hotRouteLine = readFileSync(
  new URL("../fixtures/app.mjs", import.meta.url),
  "utf8",
)
  .split("\n")
  .findIndex((l) => l.startsWith("export function hotRouteWork"));
