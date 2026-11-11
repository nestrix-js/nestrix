#!/usr/bin/env node
// Fails if a published package cannot be loaded with require() from CommonJS, which
// is what a top-level await anywhere in its static import graph causes
// (ERR_REQUIRE_ASYNC_MODULE). AGENTS.md rule 4; findings in docs/spikes/P0-S4.md.
//
// For each published package (a workspace package without `private: true`), every
// check is "require() it in a fresh child process, from the package directory", so
// Node itself decides, with its real parser, resolver and conditions:
//
//   1. Every JavaScript entry of the `exports` map (wildcard patterns and
//      ./package.json skipped). The whole static graph, dependencies included, is
//      evaluated. Any error fails the check.
//   2. Every built .js/.mjs file under dist/, not only the entries, so a top-level
//      await in a file that is only reached through a dynamic import() is found too.
//      Here only ERR_REQUIRE_ASYNC_MODULE and SyntaxError fail; other errors (a file
//      that needs a global or a peer at load time) are printed as notes.
//
// Both checks also fail on an ExperimentalWarning on stderr: loading the package must
// not need flags or print experimental warnings (a Node older than the `engines`
// floor would trip this, which is intended).
//
// Not covered: a top-level await in a dependency's file that is only reached through a
// dynamic import() (it cannot break require() of our entry). The result depends on the
// Node running it, so run it on every Node in the CI matrix. Needs `pnpm build` first.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function publishedPackages() {
  const found = [];
  for (const group of ["packages", "apps"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifestPath = join(base, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.private !== true) {
        found.push({ dir: join(base, entry.name), manifest });
      }
    }
  }
  return found;
}

function hasJsTarget(target) {
  if (typeof target === "string") return /\.(c|m)?js$/.test(target);
  if (Array.isArray(target)) return target.some(hasJsTarget);
  if (target && typeof target === "object") {
    return Object.entries(target).some(
      ([condition, value]) => condition !== "types" && hasJsTarget(value),
    );
  }
  return false;
}

/** Specifiers ("@scope/pkg", "@scope/pkg/sub") whose target is JavaScript. */
function jsEntrySpecifiers({ manifest }) {
  const exportsField = manifest.exports;
  if (exportsField === undefined) return [manifest.name];
  const map =
    typeof exportsField === "string" || Array.isArray(exportsField)
      ? { ".": exportsField }
      : exportsField;
  const specifiers = [];
  for (const [subpath, target] of Object.entries(map)) {
    if (!subpath.startsWith(".")) continue;
    if (subpath.includes("*") || subpath === "./package.json") continue;
    if (!hasJsTarget(target)) continue;
    specifiers.push(
      subpath === "." ? manifest.name : manifest.name + subpath.slice(1),
    );
  }
  return specifiers;
}

/** require(target) in a fresh child process; target is a specifier or absolute path. */
function requireInChild(cwd, target, extraNodeArgs = []) {
  return spawnSync(
    process.execPath,
    [...extraNodeArgs, "-e", `require(${JSON.stringify(target)})`],
    { cwd, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") yield* walk(path);
    } else if (/\.m?js$/.test(name)) {
      yield path;
    }
  }
}

const indent = "\n      ";
const head = (text, lines) =>
  text.trim().split("\n").slice(0, lines).join(indent);

/** Where Node says the top-level await is. */
function tlaLocation(cwd, target, fallback) {
  const diag = requireInChild(cwd, target, [
    "--experimental-print-required-tla",
  ]);
  return head(diag.stderr || fallback, 8);
}

const failures = [];
const packages = publishedPackages();
if (packages.length === 0) {
  console.error("check-no-tla: no published packages found");
  process.exit(1);
}

for (const pkg of packages) {
  const { name } = pkg.manifest;

  const specifiers = jsEntrySpecifiers(pkg);
  if (specifiers.length === 0) {
    failures.push(`${name}: no JavaScript entry in package.json "exports"`);
  }
  for (const specifier of specifiers) {
    const run = requireInChild(pkg.dir, specifier);
    if (run.status === 0 && !/ExperimentalWarning/.test(run.stderr)) {
      console.log(`ok    require("${specifier}")`);
      continue;
    }
    const detail = /ERR_REQUIRE_ASYNC_MODULE/.test(run.stderr)
      ? tlaLocation(pkg.dir, specifier, run.stderr)
      : head(run.stderr || "(no stderr)", 6);
    failures.push(`${name}: require("${specifier}") failed${indent}${detail}`);
    console.log(`FAIL  require("${specifier}")`);
  }

  const dist = join(pkg.dir, "dist");
  if (!existsSync(dist)) {
    failures.push(`${name}: ${dist} does not exist (run pnpm build first)`);
    continue;
  }
  let loaded = 0;
  let bad = 0;
  for (const file of walk(dist)) {
    const rel = file.slice(root.length + 1);
    const run = requireInChild(pkg.dir, file);
    const experimental = /ExperimentalWarning/.test(run.stderr);
    const asyncGraph = /ERR_REQUIRE_ASYNC_MODULE/.test(run.stderr);
    const syntax = /SyntaxError/.test(run.stderr);
    if (run.status === 0 && !experimental) {
      loaded++;
    } else if (asyncGraph || syntax || experimental) {
      bad++;
      const detail = asyncGraph
        ? tlaLocation(pkg.dir, file, run.stderr)
        : head(run.stderr, 6);
      failures.push(`${name}: require("${rel}") failed${indent}${detail}`);
    } else {
      console.log(
        `note  ${rel} could not be loaded standalone (not a TLA): ${head(run.stderr, 1)}`,
      );
    }
  }
  console.log(
    `${bad === 0 ? "ok   " : "FAIL "} require() of ${loaded} built file(s) of ${name}${bad ? `, ${bad} failed` : ""}`,
  );
}

if (failures.length > 0) {
  console.error(`\ncheck-no-tla: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("check-no-tla: passed");
