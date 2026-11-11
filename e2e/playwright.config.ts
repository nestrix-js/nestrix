import { defineConfig } from "@playwright/test";

// Specs are *.pw.ts so the root Vitest run (which globs *.test.ts / *.spec.ts) never loads them.
// Every test boots its own app on its own port, so tests run in parallel. Run `pnpm build` first:
// the apps are e2e/dist/*.js (plus apps-cjs/dist/main.js), built from e2e/apps and e2e/apps-cjs.
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
