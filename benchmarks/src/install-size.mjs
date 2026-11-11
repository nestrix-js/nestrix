// Install size of @nestrix/nestjs: `pnpm pack` the built package, install the tarball with
// production dependencies (`npm install --omit=dev`) into a fresh temporary directory, and `du -sk`
// node_modules, in total and per top-level package. The same is done for the host stack alone
// (Nest, platform-express, reflect-metadata, rxjs), so the cost Nestrix adds is the difference.
//   node src/install-size.mjs [--name=install-size]
// Needs `pnpm build` first (the tarball holds dist/). Needs network access for npm.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchDir,
  environmentInfo,
  mdTable,
  option,
  parseArgs,
  round,
  writeResult,
} from "./lib.mjs";

const pkgDir = join(benchDir, "..", "packages", "nestjs");

function du(path) {
  return Number(
    execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0],
  );
}

/** { "name": KiB } for every top-level package in node_modules; scoped packages by full name. */
function perPackage(nodeModules) {
  const sizes = {};
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const child of readdirSync(join(nodeModules, entry))) {
        sizes[`${entry}/${child}`] = du(join(nodeModules, entry, child));
      }
    } else {
      sizes[entry] = du(join(nodeModules, entry));
    }
  }
  return sizes;
}

function install(dir, specs) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "size-probe",
      version: "0.0.0",
      private: true,
      type: "module",
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      ...specs,
    ],
    { cwd: dir, stdio: ["ignore", "inherit", "inherit"] },
  );
  const nodeModules = join(dir, "node_modules");
  const installed = {};
  for (const [name] of Object.entries(perPackage(nodeModules))) {
    const base = join(nodeModules, name, "package.json");
    try {
      installed[name] = JSON.parse(readFileSync(base, "utf8")).version;
    } catch {
      installed[name] = "?";
    }
  }
  return {
    totalKb: du(nodeModules),
    perPackageKb: perPackage(nodeModules),
    versions: installed,
  };
}

export async function runInstallSize(args) {
  const name = String(option(args, "name", "install-size"));
  const work = mkdtempSync(join(tmpdir(), "nestrix-install-size-"));
  try {
    const packDir = join(work, "pack");
    mkdirSync(packDir);
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: pkgDir,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const tarball = join(
      packDir,
      readdirSync(packDir).find((f) => f.endsWith(".tgz")),
    );
    const tarballKb = du(tarball);
    const unpacked = (() => {
      const dir = join(work, "unpacked");
      mkdirSync(dir);
      execFileSync("tar", ["-xzf", tarball, "-C", dir]);
      return du(join(dir, "package"));
    })();

    const hostSpecs = [
      "@nestjs/common@^12",
      "@nestjs/core@^12",
      "@nestjs/platform-express@^12",
      "reflect-metadata@^0.2",
      "rxjs@^7",
    ];
    console.log("installing the host stack alone");
    const host = install(join(work, "host"), hostSpecs);
    console.log("installing the host stack with the @nestrix/nestjs tarball");
    const withNestrix = install(join(work, "with-nestrix"), [
      ...hostSpecs,
      tarball,
    ]);

    const added = {};
    for (const [pkg, kb] of Object.entries(withNestrix.perPackageKb)) {
      if (!(pkg in host.perPackageKb)) added[pkg] = kb;
    }
    const changed = {};
    for (const [pkg, kb] of Object.entries(withNestrix.perPackageKb)) {
      if (pkg in host.perPackageKb && host.perPackageKb[pkg] !== kb)
        changed[pkg] = kb - host.perPackageKb[pkg];
    }
    const addedKb = Object.values(added).reduce((a, b) => a + b, 0);
    const out = {
      environment: environmentInfo(),
      tarballKb,
      unpackedPackageKb: unpacked,
      hostOnlyKb: host.totalKb,
      withNestrixKb: withNestrix.totalKb,
      addedByNestrixKb: withNestrix.totalKb - host.totalKb,
      addedPackagesKb: added,
      addedPackagesSumKb: addedKb,
      changedPackagesKbDelta: changed,
      perPackageKbWithNestrix: withNestrix.perPackageKb,
      versions: withNestrix.versions,
    };
    const mb = (kb) => `${round(kb / 1024, 1)} MB`;
    const rows = Object.entries(added)
      .sort((a, b) => b[1] - a[1])
      .map(([p, kb]) => [p, withNestrix.versions[p], `${kb} KiB`]);
    const md = `# Install size

\`pnpm pack\` of @nestrix/nestjs, installed with \`npm install --omit=dev\` into a fresh directory (${out.environment.platform}, Node ${out.environment.node}, npm ${execFileSync("npm", ["-v"], { encoding: "utf8" }).trim()}). Sizes are \`du -sk\` (disk blocks, KiB).

- Tarball: ${tarballKb} KiB; unpacked package: ${unpacked} KiB.
- Host stack alone (@nestjs/common, core, platform-express, reflect-metadata, rxjs): ${host.totalKb} KiB (${mb(host.totalKb)}).
- Host stack plus @nestrix/nestjs: ${withNestrix.totalKb} KiB (${mb(withNestrix.totalKb)}).
- **Added by Nestrix: ${out.addedByNestrixKb} KiB (${mb(out.addedByNestrixKb)})**, of which packages not in the host stack sum to ${addedKb} KiB.
- \`@opentelemetry/api\`, a peer dependency, is counted among the added packages because the host stack above does not include it.

Packages added, largest first:

${mdTable(["package", "version", "size"], rows)}

Top-level packages with a different size once Nestrix is installed (shared dependencies resolved differently): ${Object.keys(changed).length === 0 ? "none" : JSON.stringify(changed)} (KiB delta).
`;
    writeResult(name, out, md);
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runInstallSize(parseArgs());
}
