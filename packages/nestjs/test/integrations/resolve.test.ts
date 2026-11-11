// `integrations` option resolution (backlog P3-01 item 6). No global state.
import { describe, expect, it } from "vitest";
import {
  resolveIntegrations,
  resolveOptions,
} from "../../src/resolve-options.js";

describe("integrations defaults and values", () => {
  it("pg on, mysql2 and ioredis off by default (D-49)", () => {
    expect(resolveOptions({}, {}).integrations).toEqual({
      pg: true,
      mysql2: false,
      ioredis: false,
    });
  });

  it("each can be switched; ioredis takes true or { rootSpans } (D-60)", () => {
    expect(
      resolveIntegrations({ pg: false, mysql2: true, ioredis: true }),
    ).toEqual({
      pg: false,
      mysql2: true,
      ioredis: { rootSpans: false },
    });
    expect(
      resolveIntegrations({ ioredis: { rootSpans: true } }).ioredis,
    ).toEqual({
      rootSpans: true,
    });
    expect(resolveIntegrations({ ioredis: {} }).ioredis).toEqual({
      rootSpans: false,
    });
    expect(resolveIntegrations({ ioredis: false }).ioredis).toBe(false);
  });

  it("is frozen", () => {
    const r = resolveIntegrations({ ioredis: true });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.ioredis)).toBe(true);
  });

  it.each([
    [{ pg: "yes" }, "integrations.pg must be a boolean"],
    [{ mysql2: 1 }, "integrations.mysql2 must be a boolean"],
    [
      { ioredis: "on" },
      "integrations.ioredis must be a boolean or { rootSpans?: boolean }",
    ],
    [
      { ioredis: null },
      "integrations.ioredis must be a boolean or { rootSpans?: boolean }",
    ],
    [
      { ioredis: { rootSpans: "true" } },
      "integrations.ioredis.rootSpans must be a boolean",
    ],
  ])("invalid %j throws at forRoot()", (integrations, message) => {
    expect(() => resolveOptions({ integrations } as never, {})).toThrow(
      message,
    );
  });

  it("a non-object integrations option throws", () => {
    expect(() => resolveOptions({ integrations: true } as never, {})).toThrow(
      "integrations must be an object",
    );
    expect(() => resolveOptions({ integrations: null } as never, {})).toThrow(
      "integrations must be an object",
    );
  });
});
