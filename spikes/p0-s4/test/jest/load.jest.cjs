// Q4 (Jest): a CommonJS test file that require()s the ESM-only packages.
// Needs `pnpm build` first (the third test loads the compiled ESM probe).
describe("require() of ESM-only packages under Jest", () => {
  test("@nestrix/nestjs", () => {
    const m = require("@nestrix/nestjs");
    expect(typeof m.NestrixModule.forRoot).toBe("function");
  });

  test("@nestjs/core", () => {
    const { NestFactory } = require("@nestjs/core");
    expect(typeof NestFactory.create).toBe("function");
  });

  test("@nestjs/common", () => {
    const { Injectable } = require("@nestjs/common");
    expect(typeof Injectable).toBe("function");
  });

  test("ES module with decorators (spike probe)", () => {
    require("reflect-metadata");
    const { EsmProbe, EsmDep } = require("../../dist-esm/probe.mjs");
    expect(Reflect.getMetadata("design:paramtypes", EsmProbe)).toEqual([
      EsmDep,
    ]);
  });

  test("ES module that uses import.meta.url (spike probe)", () => {
    const { reflectInfoFromEsm } = require("../../dist-esm/probe.mjs");
    expect(reflectInfoFromEsm().resolved).toMatch(/reflect-metadata/);
  });
});
