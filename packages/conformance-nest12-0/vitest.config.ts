import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the conformance suite (packages/nestjs/test/conformance-*.test.ts) with every Nest import
// resolved to this package's 12.0.0 install. The tests, packages/nestjs/src, @nestrix/testing and
// the fixture app (examples/express-esm) are transformed by Vite, so these aliases apply to
// them; the Nest packages themselves are loaded by Node from this package's node_modules and
// resolve each other there. Same wiring as spikes/p0-s1-nest12-0.
const nest = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/microservices",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "@nestjs/testing",
];

export default defineConfig({
  resolve: {
    alias: [
      ...nest.map((name) => ({
        find: new RegExp(`^${name}$`),
        replacement: fileURLToPath(import.meta.resolve(name)),
      })),
      // platform-node does not exist before 12.3.0; @nestrix/testing imports it, the suite never uses it here
      {
        find: /^@nestjs\/platform-node$/,
        replacement: fileURLToPath(
          new URL("./no-platform-node.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["../nestjs/test/conformance-*.test.ts"],
    env: {
      CONFORMANCE_ADAPTERS: "express,fastify",
      CONFORMANCE_NEST: "12.0.0",
    },
  },
});
