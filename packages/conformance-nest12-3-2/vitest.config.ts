import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the conformance suite (packages/nestjs/test/conformance-*.test.ts) with every Nest import
// resolved to this package's 12.3.2 install (see ../conformance-nest12-0/vitest.config.ts for how).
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
    include: ["../nestjs/test/conformance-*.test.ts"],
    env: { CONFORMANCE_ADAPTERS: "node", CONFORMANCE_NEST: "12.3.2" },
  },
});
