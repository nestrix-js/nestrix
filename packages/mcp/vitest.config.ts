import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/dist/**", "**/node_modules/**"],
    testTimeout: 30_000,
  },
});
