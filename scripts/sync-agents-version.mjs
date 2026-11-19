// Run after `changeset version` (the `version-packages` script): writes the packages' new version
// into AGENTS.md's "package versions in this tree: `X`", which scripts/check-readme-status.mjs
// checks. Without it every release PR fails `pnpm verify`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  readFileSync(join(root, "packages/nestjs/package.json"), "utf8"),
);
const path = join(root, "AGENTS.md");
const text = readFileSync(path, "utf8");
const pattern = /(package versions in this tree: `)[^`]+(`)/i;
if (!pattern.test(text)) {
  console.error(
    'sync-agents-version: AGENTS.md has no "package versions in this tree: `X`".',
  );
  process.exit(1);
}
writeFileSync(path, text.replace(pattern, `$1${version}$2`));
console.log(`sync-agents-version: AGENTS.md now says ${version}.`);
