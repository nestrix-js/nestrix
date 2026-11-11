import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/dist/**", "**/node_modules/**"],
    // Database containers for test/integrations (P3-01); started without waiting for readiness.
    globalSetup: ["test/integrations/containers.global.ts"],
  },
});
