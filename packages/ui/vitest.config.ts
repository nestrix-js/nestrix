import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

// Unit tests sit next to the code they test (app/**/*.test.ts). Playwright specs live in
// e2e/ (*.pw.ts) and are run by `pnpm --filter @nestrix/ui e2e`, never by the root Vitest run.
export default defineConfig({
  resolve: { alias: { "@": join(root, "app") } },
  test: {
    include: ["app/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
