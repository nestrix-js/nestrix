import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test spawns Node processes that boot Nest apps.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
