import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Re-runs the P0-S1 tests (in ../p0-s1/test) with every Nest import resolved to
// this package's 12.0.0 install. The tests and the fixture app (examples/express-esm,
// a workspace link, so Vite transforms it) are transformed by Vite, so these
// aliases apply to them; the Nest packages themselves are loaded by Node from this
// package's node_modules and resolve each other there.
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
      // platform-node does not exist before 12.3.0; the tests never load it here
      {
        find: /^@nestjs\/platform-node$/,
        replacement: fileURLToPath(
          new URL("./no-platform-node.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["../p0-s1/test/*.test.ts"],
    env: { SPIKE_ADAPTERS: "express,fastify", SPIKE_NEST: "12.0.0" },
  },
});
