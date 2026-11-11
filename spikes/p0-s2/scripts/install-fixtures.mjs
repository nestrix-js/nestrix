#!/usr/bin/env node
// Builds the isolated pnpm fixtures for Q5/Q6 (needs network or a warm pnpm store):
//   1. copies the spike's compiled pg wrapper into fixtures/standin/lib
//   2. packs the stand-in to fixtures/standin.tgz (installed like a registry package)
//   3. copies the probes and Prisma schema from fixtures/strict/app into the other apps
//   4. `pnpm install` in each fixture workspace (each has its own pnpm-workspace.yaml)
//   5. `prisma generate` and compiles the generated client with tsc
// Run `pnpm build` in spikes/p0-s2 first.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = join(root, "fixtures");
const run = (cmd, args, cwd) => {
  console.log(`$ (${cwd.replace(`${root}/`, "")}) ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
};

const dist = join(root, "dist", "src", "nestrix");
if (!existsSync(join(dist, "pg.js"))) {
  throw new Error("spikes/p0-s2 is not built: run `pnpm build` first");
}
const lib = join(fx, "standin", "lib");
rmSync(lib, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });
for (const f of ["guard.js", "sql.js", "tracing.js", "pg.js"]) {
  cpSync(join(dist, f), join(lib, f));
}
rmSync(join(fx, "standin.tgz"), { force: true });
run("pnpm", ["pack", "--out", "../standin.tgz"], join(fx, "standin"));

const source = join(fx, "strict", "app");
for (const ws of ["nopg", "nopg-nohoist"]) {
  const app = join(fx, ws, "app");
  mkdirSync(app, { recursive: true });
  if (ws === "nopg-nohoist") {
    cpSync(join(fx, "nopg", "app", "package.json"), join(app, "package.json"));
  }
  for (const f of ["orm.mjs", "orm.cjs", "tsconfig.prisma.json", "prisma"]) {
    cpSync(join(source, f), join(app, f), { recursive: true });
  }
}

for (const ws of ["strict", "nopg", "nopg-nohoist"]) {
  const dir = join(fx, ws);
  // The tarball is rebuilt each time, so start from no lockfile and no node_modules.
  rmSync(join(dir, "pnpm-lock.yaml"), { force: true });
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  rmSync(join(dir, "app", "node_modules"), { recursive: true, force: true });
  run("pnpm", ["install", "--no-frozen-lockfile"], dir);
  const app = join(dir, "app");
  run(join(app, "node_modules", ".bin", "prisma"), ["generate"], app);
  run(
    join(app, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.prisma.json"],
    app,
  );
}
console.log("fixtures installed");
