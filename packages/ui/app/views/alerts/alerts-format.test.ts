import type { AlertRule } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  describeDelivery,
  emptyForm,
  formatMetricValue,
  formFromRule,
  isKnownMetric,
  ruleState,
  summarizeRules,
  toRequest,
  webhookOrigin,
} from "@/views/alerts/alerts-format";

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "1",
  name: "checkout errors",
  service: "checkout",
  route: null,
  metric: "error_rate",
  sloId: null,
  comparator: ">",
  threshold: 0.07,
  windowMinutes: 5,
  forMinutes: 2,
  minRequests: 10,
  webhookUrl: "https://hooks.example.com/T000/secret-path",
  enabled: true,
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0,
  state: {
    state: "ok",
    sinceUnixMs: 1,
    lastValue: 0.01,
    lastEvaluatedAtUnixMs: 2,
    lastNotifiedAtUnixMs: null,
  },
  ...over,
});
const withState = (s: Partial<AlertRule["state"]>, enabled = true) =>
  rule({ enabled, state: { ...rule().state, ...s } });

describe("ruleState", () => {
  it("tells apart every state the page shows", () => {
    expect(ruleState(rule()).key).toBe("ok");
    expect(ruleState(withState({ state: "firing" })).key).toBe("firing");
    expect(ruleState(withState({ state: "pending" })).key).toBe("pending");
    expect(ruleState(withState({ lastValue: null })).key).toBe("no-data");
    expect(ruleState(withState({ lastNotifiedAtUnixMs: 5 })).key).toBe(
      "resolved",
    );
    expect(
      ruleState(withState({ lastEvaluatedAtUnixMs: null, lastValue: null }))
        .key,
    ).toBe("not-evaluated");
    expect(ruleState(withState({ state: "firing" }, false)).key).toBe(
      "disabled",
    );
  });

  it("keeps a firing rule firing when the last evaluation had no data", () => {
    const v = ruleState(withState({ state: "firing", lastValue: null }));
    expect(v.key).toBe("firing");
    expect(v.label).toContain("no data");
  });
});

describe("summarizeRules", () => {
  it("counts firing, pending and no-data rules", () => {
    expect(
      summarizeRules([
        rule(),
        withState({ state: "firing" }),
        withState({ state: "pending" }),
        withState({ lastValue: null }),
      ]),
    ).toEqual({ rules: 4, firing: 1, pending: 1, noData: 1 });
  });
});

describe("formatMetricValue", () => {
  it("writes each metric in its unit", () => {
    expect(formatMetricValue("error_rate", 0.05)).toBe("5%");
    expect(formatMetricValue("p95_ms", 300)).toBe("300 ms");
    expect(formatMetricValue("slo_burn_rate", 14.4)).toBe("14.4x");
    expect(formatMetricValue("p95_ms", null)).toBe("-");
  });
});

describe("webhookOrigin", () => {
  it("hides the path, where webhook secrets live", () => {
    expect(webhookOrigin(rule().webhookUrl)).toBe("https://hooks.example.com");
    expect(webhookOrigin("nope")).toBe("(invalid URL)");
  });
});

describe("describeDelivery", () => {
  it("gives status, HTTP code, reason and attempts, and nothing secret", () => {
    expect(
      describeDelivery({
        delivery: "failed",
        attempts: 3,
        responseStatus: 503,
        error: "http_error",
      }),
    ).toBe("failed · HTTP 503 · http error · 3 attempts");
    expect(
      describeDelivery({
        delivery: "refused",
        attempts: 0,
        responseStatus: null,
        error: "refused_address",
      }),
    ).toBe("refused · refused address");
  });
});

describe("isKnownMetric", () => {
  it("is false for a kind a newer server added", () => {
    expect(isKnownMetric("error_rate")).toBe(true);
    expect(isKnownMetric("new_error_group")).toBe(false);
  });
});

describe("formFromRule", () => {
  it("shows an error rate in percent without float noise", () => {
    expect(formFromRule({ ...rule(), metric: "error_rate" }).threshold).toBe(
      "7",
    );
  });
});

describe("toRequest", () => {
  const filled = () => ({
    ...emptyForm("checkout"),
    name: "checkout errors",
    webhookUrl: "https://hooks.example.com/x",
  });

  it("sends an error rate as a fraction with service and route, and no sloId", () => {
    const r = toRequest({ ...filled(), threshold: "7.5", route: " /pay " });
    expect(r).toEqual({
      ok: true,
      body: {
        name: "checkout errors",
        metric: "error_rate",
        threshold: 0.075,
        windowMinutes: 5,
        forMinutes: 2,
        minRequests: 10,
        webhookUrl: "https://hooks.example.com/x",
        enabled: true,
        service: "checkout",
        route: "/pay",
      },
    });
  });

  it("sends a burn-rate rule with sloId and without service or route", () => {
    const r = toRequest({
      ...filled(),
      metric: "slo_burn_rate",
      threshold: "14.4",
      sloId: "3",
    });
    expect(r.ok && r.body).toMatchObject({ sloId: "3", threshold: 14.4 });
    expect(r.ok && "service" in r.body).toBe(false);
    expect(r.ok && "route" in r.body).toBe(false);
  });

  it("requires an SLO for a burn-rate rule", () => {
    const r = toRequest({
      ...filled(),
      metric: "slo_burn_rate",
      threshold: "2",
    });
    expect(r).toEqual({ ok: false, message: "Choose an SLO." });
  });

  it.each([
    [{ name: "  " }, "Name"],
    [{ threshold: "100" }, "error rate"],
    [{ threshold: "abc" }, "number"],
    [{ windowMinutes: "4" }, "Window"],
    [{ windowMinutes: "5.5" }, "Window"],
    [{ forMinutes: "61" }, "Pending duration"],
    [{ minRequests: "0" }, "Minimum requests"],
    [{ service: "" }, "Service"],
    [{ webhookUrl: "ftp://x.example/h" }, "http or https"],
    [{ webhookUrl: "https://u:p@x.example/h" }, "credentials"],
    [{ webhookUrl: "not a url" }, "valid URL"],
  ])("refuses %j before sending", (over, text) => {
    const r = toRequest({ ...filled(), ...over });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(text);
  });

  it("bounds p95 and burn thresholds like the server", () => {
    expect(
      toRequest({ ...filled(), metric: "p95_ms", threshold: "0" }).ok,
    ).toBe(false);
    expect(
      toRequest({ ...filled(), metric: "p95_ms", threshold: "3600000" }).ok,
    ).toBe(true);
    expect(
      toRequest({
        ...filled(),
        metric: "slo_burn_rate",
        sloId: "1",
        threshold: "1001",
      }).ok,
    ).toBe(false);
  });
});
