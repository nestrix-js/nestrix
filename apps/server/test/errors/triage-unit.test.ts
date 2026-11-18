/** The pure parts of error triage: key parsing, state combination, filters, aggregation, regression. */
import type { ErrorGroup } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";
import { validateRuleInput } from "../../src/alerts/store.js";
import { aggregate, regressionTime } from "../../src/errors/sync.js";
import {
  combineTriage,
  keyHashOf,
  parseGroupKey,
  passesFilter,
  rowKey,
  type TriageRow,
  triageView,
} from "../../src/errors/triage.js";
import { groupKeyOf } from "../../src/query/error-groups.js";

const KEY = groupKeyOf("Error", "boom <n>", "/orders");

function row(
  service: string,
  key: string,
  state: TriageRow["state"],
  environment = "",
): [string, TriageRow] {
  const hash = keyHashOf(key);
  return [
    rowKey(service, environment, hash),
    {
      service_name: service,
      environment,
      key_hash: hash,
      state,
      resolved_at: new Date(1000),
      resolved_in_release: "1.0.0",
      regressed_at: new Date(2000),
      ignored_at: new Date(3000),
    },
  ];
}

describe("parseGroupKey", () => {
  it("accepts exactly what groupKeyOf produces", () => {
    expect(parseGroupKey(KEY)).toEqual({
      errorType: "Error",
      pattern: "boom <n>",
      route: "/orders",
    });
    expect(parseGroupKey(groupKeyOf(undefined, "", undefined))).toEqual({
      errorType: null,
      pattern: "",
      route: null,
    });
  });
  it("refuses anything else, so a hash is always the lists' hash", () => {
    for (const bad of [
      undefined,
      "",
      "x",
      "[]",
      `${KEY} `,
      '["Error", "boom <n>", "/orders"]',
      '["Error","a",1]',
      '[1,"a",null]',
      "a".repeat(5000),
    ]) {
      expect(parseGroupKey(bad)).toBeUndefined();
    }
  });
});

/** Places in the unset environment. */
const at = (...services: string[]) =>
  services.map((service) => ({ service, environment: "" }));

describe("combineTriage", () => {
  const rows = new Map([
    row("a", KEY, "ignored"),
    row("b", KEY, "resolved"),
    row("c", KEY, "regressed"),
  ]);
  it("a missing row is open", () => {
    expect(combineTriage(new Map(), at("a"), KEY)).toEqual({ state: "open" });
  });
  it("is ignored only when every service ignored it", () => {
    expect(combineTriage(rows, at("a"), KEY).state).toBe("ignored");
    expect(combineTriage(rows, at("a", "x"), KEY).state).toBe("open");
    expect(combineTriage(rows, at("a", "b"), KEY).state).toBe("resolved");
    expect(combineTriage(rows, at("a", "b", "x"), KEY).state).toBe("open");
    expect(combineTriage(rows, at("a", "b", "c", "x"), KEY).state).toBe(
      "regressed",
    );
  });
  it("keeps environments apart (D-101): a copy resolved in one leaves the other open", () => {
    const envRows = new Map([
      row("a", KEY, "resolved", "staging"),
      row("a", KEY, "ignored", "production"),
    ]);
    const one = (environment: string) => [{ service: "a", environment }];
    expect(combineTriage(envRows, one("staging"), KEY).state).toBe("resolved");
    expect(combineTriage(envRows, one("production"), KEY).state).toBe(
      "ignored",
    );
    // Unset is its own environment: neither stored copy applies to it.
    expect(combineTriage(envRows, one(""), KEY).state).toBe("open");
    expect(
      combineTriage(envRows, [...one("staging"), ...one("production")], KEY)
        .state,
    ).toBe("resolved");
  });
  it("reports only the fields of the state", () => {
    expect(combineTriage(rows, at("a"), KEY)).toEqual({
      state: "ignored",
      ignoredAtUnixMs: 3000,
    });
    expect(combineTriage(rows, at("b"), KEY)).toEqual({
      state: "resolved",
      resolvedAtUnixMs: 1000,
      resolvedInRelease: "1.0.0",
    });
    expect(combineTriage(rows, at("c"), KEY)).toEqual({
      state: "regressed",
      resolvedAtUnixMs: 1000,
      resolvedInRelease: "1.0.0",
      regressedAtUnixMs: 2000,
    });
  });
});

describe("filters", () => {
  it("hide ignored groups unless asked", () => {
    expect(passesFilter(undefined, "ignored")).toBe(false);
    expect(passesFilter(undefined, "regressed")).toBe(true);
    expect(passesFilter("all", "ignored")).toBe(true);
    expect(passesFilter("resolved", "open")).toBe(false);
    expect(passesFilter("open", "open")).toBe(true);
  });
  it("triageView counts what the default view leaves out", () => {
    const rows = new Map([row("a", KEY, "ignored")]);
    const g = { key: KEY, services: ["a"] } as ErrorGroup;
    const view = triageView(rows, undefined);
    expect(view.include(g)).toBe(false);
    expect(view.ignoredCount).toBe(1);
    const all = triageView(rows, "all");
    expect(all.include(g)).toBe(true);
    all.annotate(g);
    expect(g.triage?.state).toBe("ignored");
    expect(all.ignoredCount).toBe(0);
  });
});

describe("regressionTime", () => {
  const times = [
    { ms: 100, release: "1.0.0" },
    { ms: 300, release: "1.0.0" },
    { ms: 400, release: "1.1.0" },
    { ms: 500, release: undefined },
  ];
  it("ignores occurrences before the resolution and in the same release", () => {
    expect(regressionTime(times, 200, "1.0.0")).toBe(400);
    expect(regressionTime(times.slice(0, 2), 200, "1.0.0")).toBeUndefined();
    expect(regressionTime(times, 400, "1.0.0")).toBe(500);
  });
  it("any occurrence after the resolution counts when a release is unknown", () => {
    expect(regressionTime(times, 200, null)).toBe(300);
    expect(
      regressionTime([{ ms: 300, release: undefined }], 200, "1.0.0"),
    ).toBe(300);
  });
  it("an occurrence at the resolution time is not after it", () => {
    expect(
      regressionTime([{ ms: 200, release: "2" }], 200, "1"),
    ).toBeUndefined();
  });
});

describe("aggregate", () => {
  it("counts only what follows the watermark and keeps first, last and releases", () => {
    const occ = (timeUnixMs: number, release?: string, service = "shop") => ({
      traceId: "t",
      spanId: "s",
      timeUnixMs,
      errorType: "Error",
      message: `user ${timeUnixMs} not found`,
      route: "/u",
      service,
      release,
    });
    const out = aggregate(
      [
        occ(100, "1"),
        occ(200, "1"),
        occ(300, "2"),
        occ(400, undefined),
        occ(500, "2", "other"),
      ],
      250,
    );
    expect(out.size).toBe(2);
    const a = [...out.values()].find((x) => x.service === "shop");
    expect(a).toMatchObject({
      pattern: "user <n> not found",
      firstMs: 100,
      lastMs: 400,
      firstRelease: "1",
      lastRelease: "2",
      counted: 2,
    });
    expect(a?.releases.get("1")).toEqual({
      firstMs: 100,
      lastMs: 200,
      counted: 0,
    });
    expect(a?.releases.get("2")).toEqual({
      firstMs: 300,
      lastMs: 300,
      counted: 1,
    });
  });
  it("aggregates per environment (D-101), unset stored as ''", () => {
    const occ = (timeUnixMs: number, environment?: string) => ({
      traceId: "t",
      spanId: "s",
      timeUnixMs,
      errorType: "Error",
      message: "boom",
      route: "/u",
      service: "shop",
      environment,
    });
    const out = [
      ...aggregate(
        [occ(100, "staging"), occ(200, "production"), occ(300), occ(400)],
        0,
      ).values(),
    ];
    expect(out.map((a) => [a.environment, a.counted]).sort()).toEqual([
      ["", 2],
      ["production", 1],
      ["staging", 1],
    ]);
    expect(new Set(out.map((a) => a.hash)).size).toBe(1);
  });
});

describe("new_error_group rule input", () => {
  const hosts = ["hooks.example.com"];
  const url = "https://hooks.example.com/x";
  it("needs no service, threshold or window, and stores fixed ones", () => {
    const v = validateRuleInput(
      { name: "n", metric: "new_error_group", webhookUrl: url },
      false,
      hosts,
    );
    expect(v).toMatchObject({
      ok: true,
      fields: {
        metric: "new_error_group",
        threshold: 0,
        window_minutes: 5,
        for_minutes: 0,
        min_requests: 1,
      },
    });
  });
  it("accepts service and route filters", () => {
    const v = validateRuleInput(
      {
        name: "n",
        metric: "new_error_group",
        service: "shop",
        route: "/a",
        webhookUrl: url,
      },
      false,
      hosts,
    );
    expect(v).toMatchObject({
      ok: true,
      fields: { service_name: "shop", route: "/a" },
    });
  });
  it("refuses the fields that do not apply", () => {
    for (const extra of [
      { threshold: 1 },
      { windowMinutes: 5 },
      { forMinutes: 1 },
      { minRequests: 3 },
    ]) {
      const v = validateRuleInput(
        { name: "n", metric: "new_error_group", webhookUrl: url, ...extra },
        false,
        hosts,
      );
      expect(v.ok).toBe(false);
    }
  });
  it("other kinds still need a service, a threshold and a window, and cannot have a null service", () => {
    expect(
      validateRuleInput(
        {
          name: "n",
          metric: "error_rate",
          threshold: 0.1,
          windowMinutes: 5,
          webhookUrl: url,
        },
        false,
        hosts,
      ).ok,
    ).toBe(false);
    expect(
      validateRuleInput(
        {
          name: "n",
          metric: "error_rate",
          service: null,
          threshold: 0.1,
          windowMinutes: 5,
          webhookUrl: url,
        },
        false,
        hosts,
      ).ok,
    ).toBe(false);
    expect(
      validateRuleInput(
        { name: "n", metric: "error_rate", webhookUrl: url },
        false,
        hosts,
      ),
    ).toEqual({ ok: false, message: "threshold is required." });
  });
  it("changing a stored new_error_group rule to another kind needs a service", () => {
    const v = validateRuleInput(
      { metric: "error_rate", threshold: 0.1, windowMinutes: 5 },
      true,
      hosts,
      { metric: "new_error_group", threshold: 0, service_name: null },
    );
    expect(v.ok).toBe(false);
  });
});
