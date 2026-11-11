import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Each workspace directory that has a package.json is its own Vitest project and
// may bring its own vitest.config.ts. Vitest fails to start when `projects` matches
// nothing, so on a workspace with no packages yet the key is left out and the root
// is the only project (no test files, `--passWithNoTests` makes that pass).
const groups = ["packages", "apps", "examples", "spikes"];
const projects = groups.flatMap((group) =>
  existsSync(group)
    ? readdirSync(group, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() && existsSync(join(group, d.name, "package.json")),
        )
        .map((d) => `${group}/${d.name}`)
    : [],
);

export default defineConfig({
  test: projects.length > 0 ? { projects } : {},
});
