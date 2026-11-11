// `methods` option resolution (P3-02): defaults, enhancers, and invalid values throwing at forRoot().
import { describe, expect, it } from "vitest";
import { NestrixModule } from "../../src/nestrix.module.js";
import type { NestrixModuleOptions } from "../../src/options.js";
import { resolveMethods, resolveOptions } from "../../src/resolve-options.js";

class Foo {}

describe("resolveMethods", () => {
  it("defaults: enabled, nothing included or excluded, no enhancers", () => {
    expect(resolveOptions({}, {}).methods).toEqual({
      enabled: true,
      include: [],
      exclude: [],
      enhancers: [],
    });
  });

  it("keeps matchers, expands enhancers: true, de-duplicates a list, freezes", () => {
    const r = resolveMethods({
      include: [Foo, "Bar", /Baz$/],
      exclude: ["Health"],
      enhancers: ["guard", "pipe", "guard"],
    });
    expect(r.enabled).toBe(true);
    expect(r.include).toEqual([Foo, "Bar", /Baz$/]);
    expect(r.exclude).toEqual(["Health"]);
    expect(r.enhancers).toEqual(["guard", "pipe"]);
    expect(Object.isFrozen(r) && Object.isFrozen(r.include)).toBe(true);
    expect(resolveMethods({ enhancers: true }).enhancers).toEqual([
      "guard",
      "pipe",
      "interceptor",
      "filter",
    ]);
    expect(resolveMethods({ enhancers: false }).enhancers).toEqual([]);
    expect(resolveMethods(false).enabled).toBe(false);
  });

  it.each([
    [null, "methods must be false or an object"],
    ["yes", "methods must be false or an object"],
    [true, "methods must be false or an object"],
    [{ include: Foo }, "methods.include must be an array"],
    [{ exclude: [42] }, "methods.exclude entries must be a class"],
    [{ enhancers: ["middleware"] }, "methods.enhancers entries must be one of"],
    [{ enhancers: "guard" }, "methods.enhancers must be a boolean or an array"],
  ])("rejects %j at forRoot()", (methods, message) => {
    expect(() =>
      NestrixModule.forRoot({ methods } as unknown as NestrixModuleOptions),
    ).toThrow(message);
  });
});
