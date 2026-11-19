import type { AlertRule } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  conditionText,
  describeDelivery,
  emptyForm,
  formatMetricValue,
  formFromRule,
  isKnownMetric,
  METRIC_LABEL,
  ruleState,
  summarizeRules,
  thresholdForMetric,
  toRequest,
  webhookOrigin,
} from "@/views/alerts/alerts-format";

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "1",
  name: "checkout errors",
  service: "checkout",
  environment: null,
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
  it("is false only for a kind a newer server added", () => {
    expect(isKnownMetric("error_rate")).toBe(true);
    expect(isKnownMetric("new_error_group")).toBe(true);
    expect(isKnownMetric("queue_depth")).toBe(false);
  });
});

describe("conditionText", () => {
  it("states a threshold, or the event of a new-error-group rule", () => {
    expect(conditionText(rule())).toBe("Error rate > 7%");
    expect(
      conditionText(rule({ metric: "new_error_group", threshold: 0 })),
    ).toBe("an error group is new or regressed");
  });
});

describe("formFromRule", () => {
  it("shows an error rate in percent without float noise", () => {
    expect(formFromRule({ ...rule(), metric: "error_rate" }).threshold).toBe(
      "7",
    );
  });

  it("carries the environment, empty for every environment", () => {
    expect(formFromRule({ ...rule(), metric: "error_rate" }).environment).toBe(
      "",
    );
    expect(
      formFromRule({ ...rule({ environment: "staging" }), metric: "p95_ms" })
        .environment,
    ).toBe("staging");
  });

  it("gives a new-error-group rule the default threshold and window, not its stored placeholders", () => {
    const form = formFromRule({
      ...rule({
        metric: "new_error_group",
        service: null,
        environment: "production",
        route: "/pay",
        threshold: 0,
        windowMinutes: 5,
        forMinutes: 0,
        minRequests: 1,
      }),
      metric: "new_error_group",
    });
    expect(form).toMatchObject({
      metric: "new_error_group",
      service: "",
      environment: "production",
      route: "/pay",
      threshold: "5",
      forMinutes: "2",
      minRequests: "10",
    });
  });
});

describe("toRequest", () => {
  const filled = () => ({
    ...emptyForm("checkout"),
    name: "checkout errors",
    webhookUrl: "https://hooks.example.com/x",
  });

  it("names the field that is wrong, so the form can mark and focus it", () => {
    const field = (over: Partial<ReturnType<typeof filled>>) => {
      const r = toRequest({ ...filled(), ...over });
      return r.ok ? null : r.field;
    };
    expect(field({ name: "" })).toBe("name");
    expect(field({ threshold: "abc" })).toBe("threshold");
    expect(field({ windowMinutes: "4" })).toBe("windowMinutes");
    expect(field({ forMinutes: "61" })).toBe("forMinutes");
    expect(field({ minRequests: "0" })).toBe("minRequests");
    expect(field({ webhookUrl: "ftp://x" })).toBe("webhookUrl");
    expect(field({ service: "" })).toBe("service");
    expect(field({})).toBeNull();
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
        environment: null,
      },
    });
  });

  it("sends the environment of an error-rate or p95 rule, trimmed", () => {
    const r = toRequest({ ...filled(), environment: " staging " });
    expect(r.ok && r.body.environment).toBe("staging");
    const unset = toRequest({
      ...filled(),
      metric: "p95_ms",
      threshold: "300",
      environment: "unset",
    });
    expect(unset.ok && unset.body.environment).toBe("unset");
    const bad = toRequest({ ...filled(), environment: "a\u0007b" });
    expect(!bad.ok && bad.message).toContain("Environment");
  });

  it("never sends an environment with a burn-rate rule (the server takes it from the SLO)", () => {
    const r = toRequest({
      ...filled(),
      metric: "slo_burn_rate",
      threshold: "14.4",
      sloId: "3",
      environment: "staging",
    });
    expect(r.ok && "environment" in r.body).toBe(false);
  });

  describe("a new-error-group rule", () => {
    const group = () => ({
      ...filled(),
      metric: "new_error_group" as const,
      sloId: "4",
      // Whatever the other metrics left in the form is not sent.
      threshold: "not a number",
      windowMinutes: "1",
      forMinutes: "99",
      minRequests: "0",
    });
    const REFUSED = [
      "threshold",
      "windowMinutes",
      "forMinutes",
      "minRequests",
      "sloId",
      "comparator",
    ];

    it("sends name, scope and webhook only, with null for every service, route and environment", () => {
      const r = toRequest({ ...group(), service: " ", route: "" });
      expect(r).toEqual({
        ok: true,
        body: {
          name: "checkout errors",
          metric: "new_error_group",
          service: null,
          route: null,
          environment: null,
          webhookUrl: "https://hooks.example.com/x",
          enabled: true,
        },
      });
      for (const key of REFUSED) {
        expect(r.ok && key in r.body, key).toBe(false);
      }
    });

    it("sends a service, route and environment when given", () => {
      const r = toRequest({
        ...group(),
        service: "checkout",
        route: " /pay ",
        environment: "production",
      });
      expect(r.ok && r.body).toMatchObject({
        service: "checkout",
        route: "/pay",
        environment: "production",
      });
    });

    it("still checks the name, the webhook and the optional fields", () => {
      expect(toRequest({ ...group(), name: "" }).ok).toBe(false);
      const hook = toRequest({ ...group(), webhookUrl: "ftp://x.example/h" });
      expect(!hook.ok && hook.message).toContain("http or https");
      const service = toRequest({ ...group(), service: "x".repeat(257) });
      expect(!service.ok && service.message).toContain("Service");
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
    expect(r).toEqual({
      ok: false,
      message: "Choose an SLO.",
      field: "sloId",
    });
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

describe("thresholdForMetric", () => {
  it("fills the new default silently when the threshold is empty or still the old default", () => {
    expect(thresholdForMetric("error_rate", "p95_ms", "5")).toEqual({
      threshold: "500",
      note: null,
    });
    expect(thresholdForMetric("error_rate", "p95_ms", " ")).toEqual({
      threshold: "500",
      note: null,
    });
  });

  it("resets a typed value to the new default and says so", () => {
    const r = thresholdForMetric("error_rate", "p95_ms", "2.5");
    expect(r.threshold).toBe("500");
    expect(r.note).toBe(`Reset to the default for ${METRIC_LABEL.p95_ms}`);
  });

  it("keeps the text, with no note, for a metric without a threshold or an unchanged metric", () => {
    expect(thresholdForMetric("p95_ms", "new_error_group", "300")).toEqual({
      threshold: "300",
      note: null,
    });
    expect(thresholdForMetric("p95_ms", "p95_ms", "300")).toEqual({
      threshold: "300",
      note: null,
    });
  });
});
