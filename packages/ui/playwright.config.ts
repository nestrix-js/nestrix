import { defineConfig } from "@playwright/test";

// Specs are *.pw.ts so the root Vitest run (which globs *.test.ts / *.spec.ts) never loads them.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
