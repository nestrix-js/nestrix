import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Starts one Postgres 18 container for test/storage (skips without Docker unless CI is set).
    globalSetup: ["test/storage/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
