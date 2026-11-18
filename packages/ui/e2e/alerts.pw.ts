import type { Server } from "node:http";
import type { AlertEvent, AlertRule, Slo } from "@nestrix-js/protocol";
import { expect, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/${hash}`;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "1",
  name: "Checkout errors",
  service: "checkout",
  environment: null,
  route: "/pay",
  metric: "error_rate",
  sloId: null,
  comparator: ">",
  threshold: 0.05,
  windowMinutes: 10,
  forMinutes: 3,
  minRequests: 20,
  webhookUrl: "https://hooks.example.com/services/T000/B000/very-secret-token",
  enabled: true,
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0,
  state: {
    state: "firing",
    sinceUnixMs: Date.now() - 600_000,
    lastValue: 0.12,
    lastEvaluatedAtUnixMs: Date.now() - 30_000,
    lastNotifiedAtUnixMs: Date.now() - 500_000,
  },
  ...over,
});

const slo: Slo = {
  id: "7",
  name: "Orders availability",
  service: "orders",
  environment: null,
  route: null,
  kind: "availability",
  latencyThresholdMs: null,
  objective: 0.999,
  windowDays: 30,
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0,
  status: {
    totalRequests: 0,
    goodRequests: 0,
    badRequests: 0,
    attainment: null,
    errorBudget: {
      totalRequests: 0,
      remainingRequests: 0,
      remainingFraction: null,
    },
    burnRate: { "1h": null, "6h": null },
    breached: false,
  },
};

test("the Alerts page and its tab are hidden in an embedded dashboard", async ({
  page,
}) => {
  await page.goto(url());
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(page.getByRole("link", { name: "Alerts" })).toHaveCount(0);
  await page.goto(url("alerts"));
  await expect(page.getByTestId("alerts-unavailable")).toBeVisible();
  expect(mock.requests.some((r) => r.startsWith("alerts"))).toBe(false);
});

test("lists rules with their condition, state, no-data and sampling notes", async ({
  page,
}) => {
  mock.mode = "standalone";
  const evaluated = Date.now() - 30_000;
  mock.alerts = [
    rule(),
    rule({
      id: "2",
      name: "Quiet service",
      route: null,
      metric: "p95_ms",
      threshold: 300,
      forMinutes: 0,
      state: {
        state: "ok",
        sinceUnixMs: 1,
        lastValue: null,
        lastEvaluatedAtUnixMs: evaluated,
        lastNotifiedAtUnixMs: null,
      },
    }),
    rule({ id: "3", name: "Off", enabled: false }),
  ];
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await page.getByRole("link", { name: "Alerts" }).click();

  const cards = page.getByTestId("alert-rule");
  await expect(cards).toHaveCount(3);
  const first = cards.nth(0);
  await expect(first).toContainText("checkout /pay");
  await expect(first.getByTestId("rule-condition")).toHaveText(
    "Error rate > 5%",
  );
  await expect(first.getByTestId("rule-window")).toHaveText("10 min");
  await expect(first.getByTestId("rule-for")).toHaveText("3 min");
  await expect(first.getByTestId("rule-min")).toHaveText("20");
  await expect(first.getByTestId("rule-value")).toHaveText("12%");
  await expect(first).toHaveAttribute("data-state", "firing");
  // The list shows the webhook's origin; its path holds the secret and is never printed.
  await expect(first.getByTestId("rule-webhook")).toHaveText(
    "https://hooks.example.com",
  );
  await expect(page.locator("body")).not.toContainText("very-secret-token");

  await expect(cards.nth(1)).toHaveAttribute("data-state", "no-data");
  await expect(cards.nth(1).getByTestId("rule-condition")).toHaveText(
    "p95 latency > 300 ms",
  );
  await expect(cards.nth(2)).toHaveAttribute("data-state", "disabled");

  await expect(page.getByTestId("kpi-firing")).toContainText("1");
  await expect(page.getByTestId("kpi-no-data")).toContainText("1");
  await expect(page.getByTestId("alerts-note")).toContainText(
    "fewer requests than the rule's minimum",
  );
  await expect(page.getByTestId("alerts-sampling")).toContainText(
    "reflect the sampling of the services",
  );
  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test("creating a rule validates in the browser, sends a POST and shows the secret once", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.services = ["checkout"];
  const problems = watch(page);
  await page.goto(url("alerts"));
  await expect(page.getByTestId("alerts-empty")).toBeVisible();

  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByTestId("alert-form");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(form.getByRole("alert")).toContainText("Name");
  expect(mock.alertWrites).toEqual([]);

  await form.getByLabel("Name", { exact: true }).fill("Checkout errors");
  await form.getByLabel("Route (optional").fill("/pay");
  await form.getByLabel("Threshold (% of requests").fill("7.5");
  await form.getByLabel("Window").fill("4");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(form.getByRole("alert")).toContainText("Window");

  await form.getByLabel("Window").fill("15");
  await form.getByLabel("Webhook URL").fill("ftp://x.example/h");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(form.getByRole("alert")).toContainText("http or https");
  expect(mock.alertWrites).toEqual([]);

  await form.getByLabel("Webhook URL").fill("https://hooks.example.com/nx");
  await form.getByRole("button", { name: "Create rule" }).click();

  await expect(page.getByTestId("alert-rule")).toHaveCount(1);
  await expect(page.getByTestId("alert-form")).toHaveCount(0);
  await expect(page.getByTestId("new-secret-value")).toHaveValue(
    "whsec_mock-signing-secret",
  );
  expect(mock.alertWrites).toEqual([
    {
      method: "POST",
      path: "",
      body: {
        name: "Checkout errors",
        metric: "error_rate",
        threshold: 0.075,
        windowMinutes: 15,
        forMinutes: 2,
        minRequests: 10,
        webhookUrl: "https://hooks.example.com/nx",
        enabled: true,
        service: "checkout",
        route: "/pay",
        environment: null,
      },
    },
  ]);
  // Once dismissed, the secret is gone from the page.
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("new-secret")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("whsec_");
  expect(problems).toEqual([]);
});

test("a burn-rate rule picks an SLO and sends no service or route", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.slos = [slo];
  await page.goto(url("alerts"));
  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByTestId("alert-form");
  await form.getByLabel("Name", { exact: true }).fill("Orders burn");
  await form.getByLabel("Metric").selectOption("slo_burn_rate");
  await expect(form.getByLabel("Service")).toHaveCount(0);
  await form.getByLabel("Webhook URL").fill("https://hooks.example.com/nx");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(form.getByRole("alert")).toContainText("Choose an SLO");

  await form.getByLabel("SLO", { exact: true }).selectOption("7");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(page.getByTestId("alert-rule")).toHaveCount(1);
  expect(mock.alertWrites[0]?.body).toMatchObject({
    metric: "slo_burn_rate",
    sloId: "7",
    threshold: 14.4,
  });
  expect(mock.alertWrites[0]?.body).not.toHaveProperty("service");
  expect(mock.alertWrites[0]?.body).not.toHaveProperty("route");
});

test("the server's refusal of a rule is shown in the form", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.alertRefusal =
    "webhookUrl points to a private address; list the host in NESTRIX_WEBHOOK_ALLOWED_HOSTS to allow it.";
  await page.goto(url("alerts"));
  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByTestId("alert-form");
  await form.getByLabel("Name", { exact: true }).fill("Internal");
  await form.getByLabel("Service", { exact: true }).fill("checkout");
  await form.getByLabel("Webhook URL").fill("http://10.0.0.5/hook");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(form.getByRole("alert")).toContainText("private address");
  await expect(page.getByTestId("alert-rule")).toHaveCount(0);
});

test("editing sends a PATCH and deleting needs a confirmation", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.alerts = [rule()];
  await page.goto(url("alerts"));
  const card = page.getByTestId("alert-rule");
  await card.getByRole("button", { name: "Edit" }).click();
  // The form is filled from the rule: the fraction is shown as a percentage.
  await expect(page.getByLabel("Threshold (% of requests")).toHaveValue("5");
  await page.getByLabel("Name", { exact: true }).fill("Checkout, renamed");
  await page.getByLabel("Threshold (% of requests").fill("10");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(card).toContainText("Checkout, renamed");
  await expect(card.getByTestId("rule-condition")).toHaveText(
    "Error rate > 10%",
  );
  expect(mock.alertWrites.at(-1)).toMatchObject({
    method: "PATCH",
    path: "1",
    body: { name: "Checkout, renamed", threshold: 0.1 },
  });

  await card.getByRole("button", { name: "Delete" }).click();
  expect(mock.alertWrites.some((w) => w.method === "DELETE")).toBe(false);
  await card.getByRole("button", { name: "Keep" }).click();
  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByTestId("alerts-empty")).toBeVisible();
  expect(mock.alertWrites.at(-1)).toMatchObject({
    method: "DELETE",
    path: "1",
  });
});

test("a test notification is sent and its delivery shows in the history", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.alerts = [rule()];
  const past: AlertEvent = {
    id: "400",
    ruleId: "1",
    atUnixMs: Date.now() - 3_600_000,
    kind: "firing",
    value: 0.2,
    threshold: 0.05,
    delivery: "failed",
    attempts: 3,
    responseStatus: 503,
    error: "http_error",
  };
  mock.alertEvents = [past];
  await page.goto(url("alerts"));
  const card = page.getByTestId("alert-rule");
  await card.getByRole("button", { name: "History" }).click();
  const rows = card.getByTestId("history-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId("delivery-detail")).toHaveText(
    "failed · HTTP 503 · http error · 3 attempts",
  );

  await card.getByRole("button", { name: "Send test" }).click();
  await expect(card.getByTestId("test-result")).toContainText("Test sent");
  await expect(card.getByTestId("test-result")).toContainText("HTTP 200");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("test");
  expect(mock.alertWrites.at(-1)).toMatchObject({
    method: "POST",
    path: "1/test",
  });

  // A refused destination shows its reason, not a response body or a secret.
  mock.testDelivery = {
    delivery: "refused",
    responseStatus: null,
    error: "refused_address",
  };
  await card.getByRole("button", { name: "Send test" }).click();
  await expect(card.getByTestId("test-result")).toContainText(
    "refused address",
  );
  await expect(page.locator("body")).not.toContainText("whsec_");
  await expect(page.locator("body")).not.toContainText("very-secret-token");
});

test("a rule kind this page does not know is shown read-only", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.alerts = [
    rule({
      // A kind a newer server might add (`new_error_group` has a form since #26 with #19).
      metric: "queue_depth" as AlertRule["metric"],
      name: "New errors",
    }),
  ];
  const problems = watch(page);
  await page.goto(url("alerts"));
  const card = page.getByTestId("alert-rule");
  await expect(card).toContainText("New errors");
  await expect(card.getByTestId("unknown-kind")).toContainText("read-only");
  await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Delete" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("a new-error-group rule is created without threshold or window, scoped by environment", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.services = ["checkout"];
  await page.goto(url("alerts"));
  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByTestId("alert-form");
  await form.getByLabel("Name", { exact: true }).fill("New errors");
  await form.getByLabel("Metric").selectOption("new_error_group");
  await expect(form.getByLabel("Window")).toHaveCount(0);
  await expect(form.getByTestId("new-group-note")).toBeVisible();
  await form.getByLabel("Service (optional").fill("");
  await form.getByLabel("Environment (optional").fill("production");
  await form.getByLabel("Webhook URL").fill("https://hooks.example.com/nx");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(page.getByTestId("alert-rule")).toHaveCount(1);
  expect(mock.alertWrites[0]?.body).toEqual({
    name: "New errors",
    metric: "new_error_group",
    service: null,
    route: null,
    environment: "production",
    webhookUrl: "https://hooks.example.com/nx",
    enabled: true,
  });
});

test("a viewer sees the rules but no write control", async ({ page }) => {
  mock.mode = "standalone";
  mock.access = { role: "viewer", kind: "oidc", label: "ada@example.com" };
  mock.alerts = [rule()];
  await page.goto(url("alerts"));
  const card = page.getByTestId("alert-rule");
  await expect(card).toContainText("Checkout errors");
  await expect(card.getByRole("button", { name: "History" })).toBeVisible();
  for (const name of ["Send test", "Edit", "Delete"]) {
    await expect(card.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "New rule" })).toHaveCount(0);
});
