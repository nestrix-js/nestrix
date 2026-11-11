import type { Server } from "node:http";
import { expect, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { multiServiceMap } from "./mock-classes-map.ts";
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

const standalone = (services: string[]) => {
  mock.mode = "standalone";
  mock.services = services;
};
const asked = (endpoint: string) =>
  mock.requests
    .filter((r) => r.split("?")[0] === endpoint)
    .map((r) => new URLSearchParams(r.split("?")[1] ?? ""));

test("with one service there is no selector and no service parameter", async ({
  page,
}) => {
  standalone(["orders"]);
  await page.goto(url());
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(page.getByTestId("service-select")).toHaveCount(0);
  expect(asked("traces").every((q) => !q.has("service"))).toBe(true);
});

test("an embedded dashboard has no selector, no standalone badge and no sign-out", async ({
  page,
}) => {
  await page.goto(url());
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(page.getByTestId("service-select")).toHaveCount(0);
  await expect(page.getByTestId("mode")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("with several services the selector lists them and its choice is sent as service on every list and statistics query", async ({
  page,
}) => {
  standalone(["billing", "orders", "gateway"]);
  await page.goto(url());
  const select = page.getByTestId("service-select");
  await expect(select).toBeVisible();
  await expect(select.locator("option")).toHaveText([
    "All services",
    "billing",
    "orders",
    "gateway",
  ]);
  await expect(page.getByTestId("mode")).toContainText("standalone");
  expect(asked("traces").every((q) => !q.has("service"))).toBe(true);

  await select.selectOption("orders");
  await expect(page).toHaveURL(/service=orders/);
  await expect
    .poll(() => asked("traces").some((q) => q.get("service") === "orders"))
    .toBe(true);

  // Every view asks with the choice, and the choice survives navigation between views.
  for (const [name, endpoint] of [
    ["Errors", "errors"],
    ["Routes", "routes"],
    ["Classes", "classes"],
    ["Map", "map"],
  ] as const) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect
      .poll(() => asked(endpoint).some((q) => q.get("service") === "orders"))
      .toBe(true);
    await expect(select).toHaveValue("orders");
  }

  await select.selectOption("");
  await expect(page).not.toHaveURL(/service=/);
});

test("a service in the URL is sent from the first request", async ({
  page,
}) => {
  standalone(["billing", "orders"]);
  await page.goto(url("?service=billing"));
  await expect(page.getByTestId("service-select")).toHaveValue("billing");
  await expect
    .poll(() => asked("traces").some((q) => q.get("service") === "billing"))
    .toBe(true);
  expect(asked("traces").every((q) => q.get("service") === "billing")).toBe(
    true,
  );
});

test("standalone statistics say they come from stored spans", async ({
  page,
}) => {
  standalone(["billing", "orders"]);
  await page.goto(`${origin}${BASE_PATH}/#/routes`);
  await expect(page.getByTestId("statistics-note")).toContainText(
    "stored spans",
  );
  await page.goto(`${origin}${BASE_PATH}/#/map`);
  await expect(page.getByTestId("map-note")).toContainText("stored spans");
});

test("a map with several services lays services inside and targets outside, and draws service to service edges apart", async ({
  page,
}) => {
  standalone(["billing", "gateway", "orders"]);
  mock.appMap = multiServiceMap;
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(`${origin}${BASE_PATH}/#/map`);

  await expect(page.getByTestId("map-node")).toHaveCount(5);
  await expect(
    page.locator("[data-testid=map-node][data-kind=app]"),
  ).toHaveCount(3);
  await expect(page.getByTestId("map-edge")).toHaveCount(4);
  await expect(
    page.locator("[data-testid=map-edge][data-service-edge=true]"),
  ).toHaveCount(2);
  const dash = (flag: string) =>
    page
      .locator(`[data-testid=map-edge][data-service-edge=${flag}]`)
      .first()
      .evaluate((l) => getComputedStyle(l).strokeDasharray);
  expect(await dash("true")).not.toBe("none");
  expect(await dash("false")).toBe("none");

  // Services are nearer the middle of the drawing than the external targets.
  const svg = await page.getByTestId("map").boundingBox();
  if (!svg) throw new Error("no svg");
  const distance = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(selector);
    return Math.hypot(
      (box.x + box.width / 2 - (svg.x + svg.width / 2)) / svg.width,
      (box.y + box.height / 2 - (svg.y + svg.height / 2)) / svg.height,
    );
  };
  const service = Math.max(
    await distance("[data-testid=map-node][data-kind=app]"),
    await distance("[data-testid=map-node][data-kind=app] >> nth=1"),
    await distance("[data-testid=map-node][data-kind=app] >> nth=2"),
  );
  expect(service).toBeLessThan(
    await distance("[data-testid=map-node][data-kind=database]"),
  );

  // The accessible table lists every edge, service to service included.
  await expect(page.getByTestId("map-edge-row")).toHaveCount(4);
  await expect(
    page.getByTestId("map-edge-row").filter({ hasText: "billing" }).first(),
  ).toContainText("orders");
  await expect(page.getByTestId("map")).toHaveAttribute(
    "aria-label",
    /3 services/,
  );
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("sign out posts to logout next to the base and goes to login", async ({
  page,
}) => {
  standalone(["billing", "orders"]);
  await page.goto(url());
  const logout = page.waitForRequest(
    (r) => r.method() === "POST" && r.url() === `${origin}${BASE_PATH}/logout`,
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await logout;
  await expect(page).toHaveURL(`${origin}${BASE_PATH}/login`);
  expect(mock.logouts).toBe(1);
});

test("a 401 in standalone mode goes to the login page", async ({ page }) => {
  standalone(["billing", "orders"]);
  await page.goto(url());
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  mock.unauthorized = true;
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page).toHaveURL(`${origin}${BASE_PATH}/login`);
});
