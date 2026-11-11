import { defineConfig } from "vitest/config";

// Every test spawns plain `node` child processes (no flags), so they are slow-ish and
// run one file at a time against the shared database containers.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
