import { inspect } from "node:util";
import type { Provider } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NestrixModule } from "../src/nestrix.module.js";
import type { NestrixModuleOptions } from "../src/options.js";
import {
  DEFAULT_STORE,
  type ResolvedOptions,
  type ResolvedUi,
  resolveOptions,
  resolveUi,
} from "../src/resolve-options.js";
import { DEFAULT_STORE_LIMITS } from "../src/store/limits.js";
import { NESTRIX_OPTIONS } from "../src/tokens.js";

const TOKEN = "t".repeat(32);
const dev = { NODE_ENV: "development" };
const none = {};

function ui(value: unknown, env: Record<string, string> = none): ResolvedUi {
  return resolveUi(value, env);
}

function expectOff(
  r: ResolvedUi,
  reason: string,
  severity: "info" | "error",
): void {
  expect(r.mode).toBe("off");
  if (r.mode !== "off") return;
  expect(r.reason).toBe(reason);
  expect(r.severity).toBe(severity);
  expect(r.message).toMatch(/^Nestrix dashboard: off/);
}

describe("ui.logs (P9-07)", () => {
  const token = { token: "t".repeat(40) };
  const logsOf = (value: unknown): unknown => {
    const r = ui(value);
    return r.mode === "off" ? r.mode : r.logs;
  };

  it("defaults to on, and false turns it off in every mode", () => {
    expect(logsOf(undefined)).toBe(true);
    expect(logsOf({ enabled: true, auth: token })).toBe(true);
    expect(logsOf({ logs: false })).toBe(false);
    expect(logsOf({ enabled: true, auth: token, logs: false })).toBe(false);
  });

  it("a non-boolean is an invalid ui option", () => {
    const r = ui({ logs: "no" });
    expect(r.mode).toBe("off");
    if (r.mode === "off") {
      expect(r.reason).toBe("invalid");
      expect(r.message).toContain("ui.logs must be a boolean");
    }
  });
});

describe("ui.profiler (P7-02)", () => {
  const token = { token: "t".repeat(40) };
  const profilerOf = (value: unknown): unknown => {
    const r = ui(value);
    return r.mode === "off" ? r.mode : r.profiler;
  };

  it("defaults to on where the dashboard is authenticated", () => {
    expect(profilerOf(undefined)).toBe(true); // 'auto' with the startup token
    expect(profilerOf({ enabled: true, auth: token })).toBe(true);
    expect(profilerOf({ startupToken: false, auth: token })).toBe(true);
  });

  it("is off in 'auto' without the startup token and without auth, even when asked for", () => {
    expect(profilerOf({ startupToken: false })).toBe(false);
    expect(profilerOf({ startupToken: false, profiler: true })).toBe(false);
  });

  it("false turns it off in every mode", () => {
    expect(profilerOf({ profiler: false })).toBe(false);
    expect(profilerOf({ enabled: true, auth: token, profiler: false })).toBe(
      false,
    );
  });

  it("a non-boolean is an invalid ui value (dashboard off, error logged)", () => {
    const r = ui({ profiler: "yes" });
    expect(r.mode).toBe("off");
    if (r.mode === "off") {
      expect(r.reason).toBe("invalid");
      expect(r.message).toContain("ui.profiler must be a boolean");
    }
  });
});

describe("mode table (static rows)", () => {
  it("default (ui omitted) is 'auto' at /_nestrix with the startup token and no auth", () => {
    expect(ui(undefined)).toEqual({
      mode: "auto",
      path: "/_nestrix",
      startupToken: true,
      auth: undefined,
      profiler: true,
      logs: true,
    });
    expect(ui("auto")).toEqual(ui(undefined));
    expect(ui({})).toEqual(ui(undefined));
    expect(ui({ enabled: "auto" })).toEqual(ui(undefined));
  });

  it("ui: false is off, info", () => {
    expectOff(ui(false), "disabled", "info");
  });

  it("enabled: false is off, info, even with other options invalid", () => {
    expectOff(ui({ enabled: false }), "disabled", "info");
    expectOff(
      ui({ enabled: false, path: "no-slash", auth: { token: "x" } }),
      "disabled",
      "info",
    );
  });

  it("'auto' with NODE_ENV development or unset is on", () => {
    expect(ui("auto", dev).mode).toBe("auto");
    expect(ui("auto", none).mode).toBe("auto");
  });

  it.each([
    "production",
    "staging",
    "test",
    "",
    "Development",
    " development",
    "dev",
  ])("'auto' with NODE_ENV=%j is off and says how to serve it", (nodeEnv) => {
    const r = ui("auto", { NODE_ENV: nodeEnv });
    expectOff(r, "node-env", "info");
    if (r.mode === "off") {
      expect(r.message).toContain(JSON.stringify(nodeEnv));
      expect(r.message).toContain("ui: { enabled: true, auth }");
    }
  });

  it("enabled: true without auth is off with an error, and does not throw", () => {
    const r = ui({ enabled: true });
    expectOff(r, "missing-auth", "error");
  });

  it("enabled: true with auth is on in any NODE_ENV", () => {
    for (const NODE_ENV of ["production", "development", ""]) {
      const r = ui({ enabled: true, auth: { token: TOKEN } }, { NODE_ENV });
      expect(r.mode).toBe("enabled");
    }
    const r = ui({ enabled: true, auth: { authorize: () => true } }, none);
    expect(r.mode).toBe("enabled");
  });

  it("'auto' keeps auth and startupToken: false", () => {
    const r = ui({ auth: { token: TOKEN }, startupToken: false }, dev);
    expect(r.mode).toBe("auto");
    if (r.mode !== "auto") return;
    expect(r.startupToken).toBe(false);
    expect(r.auth?.kind).toBe("token");
  });

  it.each([true, null, "yes", 0, 1])("ui: %j is off with an error", (value) => {
    expectOff(ui(value), "invalid", "error");
  });

  it.each(["true", 1, null])("enabled: %j is off with an error", (enabled) => {
    expectOff(ui({ enabled, auth: { token: TOKEN } }), "invalid", "error");
  });

  it("startupToken that is not a boolean is off with an error", () => {
    expectOff(ui({ startupToken: "false" }), "invalid", "error");
    expectOff(ui({ startupToken: 0 }), "invalid", "error");
    expectOff(ui({ startupToken: null }), "invalid", "error");
  });
});

describe("ui.path", () => {
  it.each([
    ["/_nestrix", "/_nestrix"],
    ["/_nestrix/", "/_nestrix"],
    ["/admin/observe", "/admin/observe"],
    ["/a.b_c~d-e/F9", "/a.b_c~d-e/F9"],
    ["/.well", "/.well"],
  ])("%j resolves to %j", (path, expected) => {
    const r = ui({ path });
    expect(r.mode).toBe("auto");
    if (r.mode === "auto") expect(r.path).toBe(expected);
  });

  it.each([
    "",
    "/",
    "//",
    "_nestrix",
    "/_nestrix//",
    "//evil.example",
    "/a//b",
    "/a/./b",
    "/a/../b",
    "/..",
    "/.",
    "/with space",
    "/semi;colon",
    "/comma,x",
    "/percent%2F",
    "/query?x",
    "/hash#x",
    "/ünicode",
    "/back\\slash",
    " /_nestrix",
  ])("%j is off with an error", (path) => {
    expectOff(ui({ path }), "invalid", "error");
  });

  it("a non-string path is off with an error", () => {
    expectOff(ui({ path: 1 }), "invalid", "error");
    expectOff(ui({ path: null }), "invalid", "error");
  });

  it("an invalid path is reported even where NODE_ENV would turn the dashboard off", () => {
    expectOff(
      ui({ path: "bad" }, { NODE_ENV: "production" }),
      "invalid",
      "error",
    );
  });
});

describe("ui.auth", () => {
  it("a token of 31 characters is an error, 32 is accepted", () => {
    expectOff(
      ui({ enabled: true, auth: { token: "x".repeat(31) } }),
      "invalid",
      "error",
    );
    expect(ui({ enabled: true, auth: { token: "x".repeat(32) } }).mode).toBe(
      "enabled",
    );
  });

  it("a short token is an error in 'auto' mode too (auth is never dropped silently)", () => {
    expectOff(ui({ auth: { token: "short" } }, dev), "invalid", "error");
  });

  it.each([
    ["empty token", { token: "" }],
    ["numeric token", { token: 1e40 }],
    ["authorize not a function", { authorize: true }],
    ["both", { token: TOKEN, authorize: () => true }],
    ["neither", {}],
    ["null", null],
    ["string", TOKEN],
  ])("%s is off with an error", (_name, auth) => {
    expectOff(ui({ enabled: true, auth }), "invalid", "error");
  });

  it("an error message never contains the token", () => {
    const given = "marker-value-short";
    const r = ui({ enabled: true, auth: { token: given } });
    expect(r.mode).toBe("off");
    if (r.mode === "off") expect(r.message).not.toContain(given);
  });

  it("a valid token is not kept in plain text anywhere in the resolved options", () => {
    const given = `marker-value-${"z".repeat(40)}`;
    const r = resolveOptions(
      { ui: { enabled: true, auth: { token: given } } },
      none,
    );
    const dump = inspect(r, { depth: 10 });
    expect(dump).not.toContain(given);
    expect(JSON.stringify(r)).not.toContain(given);
    expect(dump).not.toContain(Buffer.from(given).toString("base64"));
    expect(dump).not.toContain(Buffer.from(given).toString("hex"));
  });

  it("custom authorize is kept with its object as this", () => {
    const auth = { authorize: () => true };
    const r = ui({ enabled: true, auth });
    expect(r.mode).toBe("enabled");
    if (r.mode !== "enabled" || r.auth.kind !== "custom") return;
    expect(r.auth.authorize).toBe(auth.authorize);
    expect(r.auth.thisArg).toBe(auth);
  });

  it("authorize from a class prototype is accepted", () => {
    class Gate {
      authorize(): boolean {
        return true;
      }
    }
    expect(ui({ enabled: true, auth: new Gate() }).mode).toBe("enabled");
  });
});

describe("resolveUi never throws", () => {
  it("a getter that throws turns the dashboard off with an error that names no value", () => {
    const secret = "SECRET-VALUE-IN-ERROR";
    const r = resolveUi(
      {
        get path(): string {
          throw new Error(secret);
        },
      },
      none,
    );
    expectOff(r, "invalid", "error");
    expect(r.mode === "off" && r.message).not.toContain(secret);
  });
});

describe("NODE_ENV source", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolveUi reads NODE_ENV from the env argument, not from process.env", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(ui("auto", none).mode).toBe("auto");
    vi.stubEnv("NODE_ENV", "development");
    expect(ui("auto", { NODE_ENV: "production" }).mode).toBe("off");
  });

  function resolvedFromForRoot(options: NestrixModuleOptions): ResolvedOptions {
    const mod = NestrixModule.forRoot(options);
    const provider = (mod.providers ?? []).find(
      (p: Provider) =>
        typeof p === "object" &&
        "provide" in p &&
        p.provide === NESTRIX_OPTIONS,
    ) as { useValue: ResolvedOptions };
    return provider.useValue;
  }

  it("NestrixModule.forRoot reads NODE_ENV from process.env, as it reads the other variables", () => {
    vi.stubEnv("NODE_ENV", "production");
    const prod = resolvedFromForRoot({});
    expect(prod.ui.mode).toBe("off");
    if (prod.ui.mode === "off") expect(prod.ui.reason).toBe("node-env");

    vi.stubEnv("NODE_ENV", "development");
    expect(resolvedFromForRoot({}).ui.mode).toBe("auto");
  });
});

describe("store", () => {
  it("defaults are 5000 traces and 32 MiB (measured in P2-12), the same in the store's own limits", () => {
    expect(DEFAULT_STORE).toEqual({ maxTraces: 5000, maxBytes: 33554432 });
    expect(DEFAULT_STORE).toEqual(DEFAULT_STORE_LIMITS);
    expect(Object.isFrozen(DEFAULT_STORE)).toBe(true);
    expect(resolveOptions(undefined, none).store).toEqual(DEFAULT_STORE);
  });

  it("each limit overrides its default alone; undefined keeps the default", () => {
    expect(resolveOptions({ store: { maxTraces: 5 } }, none).store).toEqual({
      maxTraces: 5,
      maxBytes: DEFAULT_STORE.maxBytes,
    });
    expect(
      resolveOptions({ store: { maxTraces: undefined, maxBytes: 1024 } }, none)
        .store,
    ).toEqual({ maxTraces: DEFAULT_STORE.maxTraces, maxBytes: 1024 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %s like every other numeric option",
    (n) => {
      expect(() => resolveOptions({ store: { maxTraces: n } }, none)).toThrow(
        /^Invalid Nestrix options: store\.maxTraces/,
      );
      expect(() => resolveOptions({ store: { maxBytes: n } }, none)).toThrow(
        /^Invalid Nestrix options: store\.maxBytes/,
      );
    },
  );

  it("is frozen", () => {
    const r = resolveOptions(undefined, none);
    expect(Object.isFrozen(r.store)).toBe(true);
    expect(Object.isFrozen(r.ui)).toBe(true);
  });
});

describe("resolveOptions never throws for ui", () => {
  it.each<[string, unknown]>([
    ["enabled without auth", { enabled: true }],
    ["bad path", { path: "x" }],
    ["short token", { enabled: true, auth: { token: "x" } }],
    ["garbage", 42],
  ])("%s", (_name, value) => {
    expect(() =>
      resolveOptions({ ui: value as NestrixModuleOptions["ui"] }, none),
    ).not.toThrow();
  });
});
