#!/usr/bin/env node
// `pnpm release`: publishes the packages with pending versions to npm through Changesets.
//
// Refuses to run anywhere except the publish job of .github/workflows/release.yml on `main`,
// so a local `pnpm release` (or a stray `pnpm run release`) cannot publish by accident.
// The first publish, which npm requires to be manual, is a deliberate `pnpm publish` per
// package; see RELEASING.md.

import { spawnSync } from "node:child_process";

const ref = process.env.GITHUB_WORKFLOW_REF ?? "";
const inReleaseWorkflow =
  process.env.GITHUB_ACTIONS === "true" &&
  ref.includes("/.github/workflows/release.yml@refs/heads/main");

if (!inReleaseWorkflow) {
  console.error(
    "Refusing to publish: `pnpm release` only runs inside .github/workflows/release.yml on main.\n" +
      "Nothing was published. See RELEASING.md.",
  );
  process.exit(1);
}

const result = spawnSync("pnpm", ["exec", "changeset", "publish"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
