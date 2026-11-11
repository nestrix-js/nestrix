#!/usr/bin/env node
// Downloads the Node versions of the CI matrix that are not the running one into
// spikes/p0-s2/.node/ (gitignored), from nodejs.org. Tests pick them up automatically;
// NODE_22 / NODE_24 env vars (paths to a node binary) take precedence.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".node");
mkdirSync(dir, { recursive: true });
const platform = process.platform === "win32" ? "win" : process.platform;
for (const version of ["22.15.0", "24.22.2"]) {
  const name = `node-v${version}-${platform}-${process.arch}`;
  if (existsSync(join(dir, name, "bin", "node"))) {
    console.log(`${name} present`);
    continue;
  }
  const url = `https://nodejs.org/dist/v${version}/${name}.tar.gz`;
  console.log(`downloading ${url}`);
  execFileSync("sh", ["-c", `curl -sSfL "${url}" | tar xz -C "${dir}"`], {
    stdio: "inherit",
  });
}
