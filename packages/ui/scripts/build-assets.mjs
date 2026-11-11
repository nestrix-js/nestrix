// Builds the dashboard SPA into dist/ and writes dist/manifest.json, a sorted list of
// every file in dist/ (path, size, sha256, content type). Runs after `tsc -b`, which
// writes the Node entry (dist/index.js, dist/index.d.ts) into the same directory, so
// only the files this script owns are removed first.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ts": "text/plain; charset=utf-8",
};

for (const stale of [
  "assets",
  "index.html",
  "THIRD_PARTY_NOTICES.txt",
  "manifest.json",
]) {
  rmSync(join(dist, stale), { recursive: true, force: true });
}

const vite = spawnSync(
  process.execPath,
  [join(root, "node_modules/vite/bin/vite.js"), "build"],
  {
    cwd: root,
    stdio: "inherit",
    // A NODE_ENV=development in the caller's shell would otherwise bundle React's development build.
    env: { ...process.env, NODE_ENV: "production" },
  },
);
if (vite.status !== 0) process.exit(vite.status ?? 1);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(dist)
  .map((full) => {
    const ext = extname(full);
    const contentType = contentTypes[ext];
    if (!contentType)
      throw new Error(
        `No content type for ${full}; add ${ext} to build-assets.mjs`,
      );
    return {
      path: relative(dist, full).split(sep).join("/"),
      size: statSync(full).size,
      sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
      contentType,
    };
  })
  .sort((a, b) => (a.path < b.path ? -1 : 1));

writeFileSync(
  join(dist, "manifest.json"),
  `${JSON.stringify({ files }, null, 2)}\n`,
);
