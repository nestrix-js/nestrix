import type { Server } from "node:http";
import type { Slo } from "@nestrix/protocol";
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

const slo = (over: Partial<Slo> = {}): Slo => ({
  id: "1",
  name: "Checkout availability",
  service: "orders",
  route: "/checkout",
  kind: "availability",
  latencyThresholdMs: null,
  objective: 0.999,
  windowDays: 30,
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0,
  status: {
    totalRequests: 20000,
    goodRequests: 19990,
    badRequests: 10,
    attainment: 0.9995,
    errorBudget: {
      totalRequests: 20,
      remainingRequests: 10,
      remainingFraction: 0.5,
    },
    burnRate: { "1h": 14.4, "6h": 2 },
    breached: false,
  },
  ...over,
});

test("the SLOs page and its tab are hidden in an embedded dashboard", async ({
  page,
}) => {
  await page.goto(url());
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(page.getByRole("link", { name: "SLOs" })).toHaveCount(0);
  await page.goto(url("slos"));
  await expect(page.getByTestId("slos-unavailable")).toBeVisible();
  expect(mock.requests.some((r) => r.startsWith("slos"))).toBe(false);
});

test("lists SLOs with objective, attainment, budget bar and burn rates", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.services = ["orders", "billing"];
  mock.slos = [
    slo(),
    slo({
      id: "2",
      name: "Billing latency",
      service: "billing",
      route: null,
      kind: "latency",
      latencyThresholdMs: 300,
      objective: 0.99,
      windowDays: 7,
      status: {
        ...slo().status,
        attainment: 0.95,
        errorBudget: {
          totalRequests: 200,
          remainingRequests: -300,
          remainingFraction: -1.5,
        },
        burnRate: { "1h": null, "6h": 5 },
        breached: true,
      },
    }),
  ];
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await page.getByRole("link", { name: "SLOs" }).click();

  const cards = page.getByTestId("slo");
  await expect(cards).toHaveCount(2);
  const first = cards.nth(0);
  await expect(first).toContainText("Checkout availability");
  await expect(first.getByTestId("objective")).toHaveText("99.9%");
  await expect(first.getByTestId("attainment")).toHaveText("99.95%");
  await expect(first.getByTestId("burn-1h")).toHaveText("14.4x");
  await expect(first.getByTestId("burn-6h")).toHaveText("2x");
  await expect(first.getByTestId("budget-bar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await expect(first.getByTestId("budget-text")).toContainText(
    "50% of the budget left",
  );
  await expect(first).toHaveAttribute("data-state", "ok");

  const second = cards.nth(1);
  await expect(second).toContainText("Breached");
  await expect(second).toContainText("faster than 300 ms");
  await expect(second.getByTestId("burn-1h")).toHaveText("-");
  await expect(second.getByTestId("budget-bar")).toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  await expect(second.getByTestId("budget-text")).toContainText(
    "overspent by 150%",
  );
  await expect(second).toHaveAttribute("data-state", "spent");

  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test("creating an SLO sends a POST with the objective as a fraction and lists it", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.services = ["orders"];
  const problems = watch(page);
  await page.goto(url("slos"));
  await expect(page.getByTestId("slos-empty")).toBeVisible();

  await page.getByRole("button", { name: "New SLO" }).click();
  const form = page.getByTestId("slo-form");
  // An invalid form is refused in the browser, with nothing sent.
  await form.getByRole("button", { name: "Create SLO" }).click();
  await expect(form.getByRole("alert")).toContainText("name");
  expect(mock.sloWrites).toEqual([]);

  await form.getByLabel("Name").fill("Orders latency");
  await form.getByLabel("Kind").selectOption("latency");
  await form.getByLabel("Threshold (ms)").fill("250");
  await form.getByLabel("Objective (%)").fill("99");
  await form.getByLabel("Window").selectOption("7");
  await form.getByRole("button", { name: "Create SLO" }).click();

  await expect(page.getByTestId("slo")).toHaveCount(1);
  await expect(page.getByTestId("slo")).toContainText("Orders latency");
  await expect(page.getByTestId("slo-form")).toHaveCount(0);
  expect(mock.sloWrites).toEqual([
    {
      method: "POST",
      id: null,
      body: {
        name: "Orders latency",
        service: "orders",
        route: null,
        kind: "latency",
        latencyThresholdMs: 250,
        objective: 0.99,
        windowDays: 7,
      },
    },
  ]);
  expect(problems).toEqual([]);
});

test("editing sends a PATCH and deleting needs a confirmation", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.slos = [slo()];
  await page.goto(url("slos"));
  const card = page.getByTestId("slo");
  await card.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Name").fill("Checkout, renamed");
  await page.getByLabel("Objective (%)").fill("99.5");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(card).toContainText("Checkout, renamed");
  expect(mock.sloWrites.at(-1)).toMatchObject({
    method: "PATCH",
    id: "1",
    body: { name: "Checkout, renamed", objective: 0.995 },
  });

  await card.getByRole("button", { name: "Delete" }).click();
  // Nothing is deleted until it is confirmed; "Keep" backs out.
  expect(mock.sloWrites.some((w) => w.method === "DELETE")).toBe(false);
  await card.getByRole("button", { name: "Keep" }).click();
  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByTestId("slos-empty")).toBeVisible();
  expect(mock.sloWrites.at(-1)).toMatchObject({ method: "DELETE", id: "1" });
});

test("a server refusal is shown in the form and keeps what was typed", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.services = ["orders"];
  mock.sloRefusal = "objective must be a fraction above 0 and below 1.";
  await page.goto(url("slos"));
  await page.getByRole("button", { name: "New SLO" }).click();
  await page.getByLabel("Name").fill("Kept name");
  await page.getByRole("button", { name: "Create SLO" }).click();
  const form = page.getByTestId("slo-form");
  await expect(form.getByRole("alert")).toContainText("objective must be");
  await expect(page.getByLabel("Name")).toHaveValue("Kept name");
  expect(mock.slos).toEqual([]);
});
