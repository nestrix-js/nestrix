// Copies static assets from src/ into dist/ and writes dist/manifest.json, a
// sorted list of every file in dist/ (path, size, sha256). Runs after `tsc -b`.
import { createHash } from "node:crypto";
import {
  cpSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

cpSync(join(src, "index.html"), join(dist, "index.html"));

const skip = (name) => name === "manifest.json";

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return skip(entry.name) ? [] : [full];
  });
}

const files = walk(dist)
  .map((full) => {
    const bytes = readFileSync(full);
    return {
      path: relative(dist, full).split(sep).join("/"),
      size: statSync(full).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  })
  .sort((a, b) => (a.path < b.path ? -1 : 1));

writeFileSync(
  join(dist, "manifest.json"),
  `${JSON.stringify({ files }, null, 2)}\n`,
);
