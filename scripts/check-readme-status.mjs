// Fails when a README states a version in its status line that is not the package's own version
// (issue #46: "Status: 0.1.0" stayed in the READMEs while the packages moved on). The simplest
// way to pass is to name no version at all, so the status lines say "pre-1.0".
//   node scripts/check-readme-status.mjs            check the repository
//   node scripts/check-readme-status.mjs <dir>...   check these package directories instead
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;
const STATUS_LINE = /^\s*(?:>\s*)?(?:\*\*|__)?Status\b/i;

/** Problems found in one README; `version` is the package's own version. */
export function checkReadme(text, version, label) {
  const problems = [];
  text.split("\n").forEach((line, i) => {
    if (!STATUS_LINE.test(line)) return;
    for (const found of line.match(VERSION) ?? []) {
      if (found !== version) {
        problems.push(
          `${label}:${i + 1}: status line names version ${found}, but the package is ${version}. Name no version (say "pre-1.0").`,
        );
      }
    }
  });
  return problems;
}

function publishedPackageDirs() {
  const packages = join(root, "packages");
  return readdirSync(packages)
    .map((name) => join(packages, name))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .filter(
      (dir) =>
        !JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).private,
    );
}

function run(dirs) {
  const problems = [];
  const targets = dirs.map((dir) => ({ dir, readme: join(dir, "README.md") }));
  for (const { dir, readme } of targets) {
    if (!existsSync(readme)) continue;
    const { version } = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    problems.push(
      ...checkReadme(readFileSync(readme, "utf8"), version, readme),
    );
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).map((p) => resolve(p));
  let problems;
  if (args.length > 0) {
    problems = run(args);
  } else {
    problems = run(publishedPackageDirs());
    // The repository README speaks for the three packages, which share one version.
    const version = JSON.parse(
      readFileSync(join(root, "packages/nestjs/package.json"), "utf8"),
    ).version;
    problems.push(
      ...checkReadme(
        readFileSync(join(root, "README.md"), "utf8"),
        version,
        "README.md",
      ),
    );
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("README status lines: ok");
}
