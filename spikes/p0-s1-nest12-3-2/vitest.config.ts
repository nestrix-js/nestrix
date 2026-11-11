import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Re-runs the P0-S1 tests (in ../p0-s1/test) with every Nest import resolved to
// this package's 12.3.2 install (see ../p0-s1-nest12-0/vitest.config.ts for how).
// platform-node only: 12.3.2 is the release that matters for it.
const nest = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/microservices",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "@nestjs/platform-node",
  "@nestjs/testing",
];

export default defineConfig({
  resolve: {
    alias: nest.map((name) => ({
      find: new RegExp(`^${name}$`),
      replacement: fileURLToPath(import.meta.resolve(name)),
    })),
  },
  test: {
    include: ["../p0-s1/test/*.test.ts"],
    env: { SPIKE_ADAPTERS: "node", SPIKE_NEST: "12.3.2" },
  },
});
