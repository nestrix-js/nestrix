// Q4 (Vitest 4) in a "type": "commonjs" package. Needs `pnpm build` first.
import { createRequire } from "node:module";
import { NestFactory } from "@nestjs/core";
import { NestrixModule } from "@nestrix/nestjs";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);

test("import of @nestrix/nestjs and @nestjs/core", () => {
  expect(typeof NestrixModule.forRoot).toBe("function");
  expect(typeof NestFactory.create).toBe("function");
});

test("require() of the ESM-only packages", () => {
  expect(typeof require("@nestrix/nestjs").NestrixModule.forRoot).toBe(
    "function",
  );
  expect(typeof require("@nestjs/core").NestFactory.create).toBe("function");
});

test("require() of an ES module with decorators (spike probe)", () => {
  require("reflect-metadata");
  const { EsmProbe, EsmDep } = require("../../dist-esm/probe.mjs");
  expect(Reflect.getMetadata("design:paramtypes", EsmProbe)).toEqual([EsmDep]);
});
