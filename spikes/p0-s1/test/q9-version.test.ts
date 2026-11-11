import { HttpAdapterHost } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { describe, expect, it } from "vitest";
import { BARE_HOOK_RUNNER, NEST_LABEL } from "../src/boot.js";

/**
 * Checks that a re-run loads the Nest version it says it does (the
 * p0-s1-nest12-* packages alias every Nest import to their own install).
 */
describe(`Q9 the Nest version under test is the one loaded [Nest ${NEST_LABEL}]`, () => {
  it("@nestjs/core's file path names the expected version", () => {
    // pnpm stores each package under `.pnpm/@nestjs+core@<version>_…`; a stack
    // captured inside the HttpAdapterHost setter shows which copy ran
    let stack = "";
    const host = new HttpAdapterHost();
    host.init$.subscribe(() => {
      stack = new Error("probe").stack ?? "";
    });
    host.httpAdapter = {} as never;
    const versions = new Set(
      [...stack.matchAll(/@nestjs\+core@(\d+\.\d+\.\d+)/g)].map((m) => m[1]),
    );
    expect([...versions]).toEqual([NEST_LABEL]);
  });

  it("has (or lacks) the guarded hook runners, which start at 12.1.3", () => {
    expect("runRequestHook" in ExpressAdapter.prototype).toBe(
      !BARE_HOOK_RUNNER,
    );
    expect("runLifecycleHook" in FastifyAdapter.prototype).toBe(
      !BARE_HOOK_RUNNER,
    );
  });
});
