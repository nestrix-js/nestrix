// Copies the shared statistics wording (packages/protocol/src/statistics-wording.ts) into
// @nestrix-js/mcp, which is published without the private protocol package (issue #45).
//   node scripts/sync-statistics-wording.mjs           write the copy
//   node scripts/sync-statistics-wording.mjs --check   exit 1 when the copy is stale
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/protocol/src/statistics-wording.ts");
const target = resolve(root, "packages/mcp/src/render/statistics-wording.ts");
const header =
  "// GENERATED from packages/protocol/src/statistics-wording.ts by scripts/sync-statistics-wording.mjs.\n// Edit the source and run `pnpm --filter @nestrix-js/mcp build`; do not edit this copy.\n\n";
const expected = header + readFileSync(source, "utf8");

if (process.argv.includes("--check")) {
  let actual = "";
  try {
    actual = readFileSync(target, "utf8");
  } catch {}
  if (actual !== expected) {
    console.error(
      "packages/mcp/src/render/statistics-wording.ts is stale: run node scripts/sync-statistics-wording.mjs",
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, expected);
}
