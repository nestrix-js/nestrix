import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import {
  classesDisabled,
  classesEmpty,
  classesNoDataInRange,
} from "./mock-classes-map.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/classes${hash}`;
const rows = (page: Page) => page.getByTestId("class-row");
const methodRows = (page: Page) => page.getByTestId("method-row");
const names = (page: Page) =>
  rows(page).evaluateAll((trs) =>
    trs.map((tr) => tr.querySelector("td")?.textContent?.trim()),
  );
const windowButton = (page: Page, minutes: number) =>
  page.getByRole("button", { name: `${minutes} min`, exact: true });
const asked = () =>
  mock.requests
    .filter((r) => r.startsWith("classes"))
    .map((r) => new URLSearchParams(r.split("?")[1]).get("windowMinutes"));

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

test("renders classes with kind, counts, durations and own time, busiest total first", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await expect(rows(page)).toHaveCount(4);
  // Total time: OrdersService 40*9+10*70+5*1 = 1065, OrdersController 40*12+10*80 = 1280.
  expect(await names(page)).toEqual([
    "OrdersController",
    "OrdersService",
    "OrdersRepository",
    "AuthGuard",
  ]);
  const first = rows(page).nth(0).locator("td");
  await expect(first.nth(1)).toHaveText("controller");
  await expect(first.nth(2)).toHaveText("50");
  await expect(first.nth(3)).toHaveText("3");
  await expect(first.nth(4)).toHaveText("25.6 ms");
  await expect(first.nth(5)).toHaveText("1.28 s");
  // Own: 40*2 + 10*5 = 130 ms.
  await expect(first.nth(6)).toHaveText("130 ms");
  // A class without any estimate shows a dash, not 0.
  await expect(rows(page).nth(3).locator("td").nth(6)).toHaveText("-");
  await expect(page.getByTestId("own-note")).toContainText("sampled traces");
  await expect(methodRows(page)).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("a row expands to its methods and collapses again", async ({ page }) => {
  await page.goto(url());
  const service = rows(page).filter({ hasText: "OrdersService" });
  await service.getByRole("button").click();
  await expect(methodRows(page)).toHaveCount(3);
  await expect(service.getByRole("button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  // Methods are in the class's sort order (total desc): place 700, findAll 360, audit 5.
  const first = methodRows(page).nth(0).locator("td");
  await expect(first.nth(0)).toHaveText("place");
  await expect(first.nth(3)).toHaveText("3");
  await expect(first.nth(6)).toHaveText("200 ms"); // 20 ms * 10 calls
  await expect(methodRows(page).nth(2).locator("td").nth(6)).toHaveText("-");
  await service.getByRole("button").click();
  await expect(methodRows(page)).toHaveCount(0);
});

test("sorting by a column reorders the classes and the choice is in the URL", async ({
  page,
}) => {
  await page.goto(url());
  await page.getByTestId("sort-name").click();
  expect(await names(page)).toEqual([
    "AuthGuard",
    "OrdersController",
    "OrdersRepository",
    "OrdersService",
  ]);
  await expect(page.locator("th[aria-sort='ascending']")).toHaveText("Class");
  await expect(page).toHaveURL(/sort=name&dir=asc$/);
  await page.getByTestId("sort-name").click();
  expect((await names(page))[0]).toBe("OrdersService");
  // Descending is the default direction, so it is not written to the URL.
  await expect(page).toHaveURL(/sort=name$/);

  await page.getByTestId("sort-calls").click();
  // Calls desc: AuthGuard and OrdersRepository 50, OrdersController 50, OrdersService 55.
  expect((await names(page))[0]).toBe("OrdersService");
  await page.getByTestId("sort-errors").click();
  expect((await names(page)).slice(0, 2).sort()).toEqual([
    "OrdersController",
    "OrdersService",
  ]);
  // A reload keeps the sort (once the URL has caught up with the click).
  await expect(page).toHaveURL(/sort=errors/);
  await page.reload();
  await expect(page.locator("th[aria-sort='descending']")).toHaveText("Errors");
});

test("methods follow the sort too", async ({ page }) => {
  await page.goto(url("?sort=calls"));
  await rows(page)
    .filter({ hasText: "OrdersController" })
    .getByRole("button")
    .click();
  await expect(methodRows(page).nth(0).locator("td").nth(0)).toHaveText("list");
  await page.getByTestId("sort-calls").click(); // now ascending
  await expect(methodRows(page).nth(0).locator("td").nth(0)).toHaveText(
    "create",
  );
});

test("the 15 and 60 minute window toggle asks the API and is in the URL", async ({
  page,
}) => {
  await page.goto(url());
  await expect(rows(page).nth(0).locator("td").nth(2)).toHaveText("50");
  await expect(windowButton(page, 15)).toHaveAttribute("aria-pressed", "true");
  await windowButton(page, 60).click();
  await expect(rows(page).nth(0).locator("td").nth(2)).toHaveText("200");
  expect(asked()).toContain("60");
  await expect(page).toHaveURL(/windowMinutes=60/);
  await page.reload();
  await expect(windowButton(page, 60)).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page).nth(0).locator("td").nth(2)).toHaveText("200");
});

test("when method spans are off, the page shows the line for main.ts and no table", async ({
  page,
}) => {
  mock.classStats = classesDisabled;
  await page.goto(url());
  const box = page.getByTestId("methods-disabled");
  await expect(box).toBeVisible();
  await expect(box).toContainText(
    "NestFactory.create(AppModule, { instrument: NestrixInstrument })",
  );
  await expect(box).toContainText("NestFactory.createApplicationContext");
  await expect(box).toContainText("NestFactory.createMicroservice");
  await expect(page.getByTestId("classes")).toHaveCount(0);
});

test("idle longer than the window says no data in range, not off, and the window toggle still works", async ({
  page,
}) => {
  mock.classStats = classesNoDataInRange;
  await page.goto(url());
  const box = page.getByTestId("methods-no-data-in-range");
  await expect(box).toContainText(
    "No method spans from this service in the selected range",
  );
  await expect(box).toContainText("Widen the range");
  await expect(page.getByTestId("methods-disabled")).toHaveCount(0);
  await expect(page.getByTestId("classes")).toHaveCount(0);
  await windowButton(page, 60).click();
  await expect(windowButton(page, 60)).toHaveAttribute("aria-pressed", "true");
  await expect(box).toContainText("last 60 minutes");
});

test("methods on but nothing called says so", async ({ page }) => {
  mock.classStats = classesEmpty;
  await page.goto(url());
  await expect(page.getByTestId("classes")).toContainText(
    "No method calls in the last 15 minutes.",
  );
  await expect(page.getByTestId("methods-disabled")).toHaveCount(0);
});

test("a failing API shows an error with a retry", async ({ page }) => {
  mock.failing.add("classes");
  await page.goto(url());
  await expect(page.getByRole("alert")).toContainText(
    "Could not load class statistics.",
  );
  mock.failing.clear();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(rows(page)).toHaveCount(4);
});

test("the navigation links to the classes view", async ({ page }) => {
  await page.goto(`${origin}${BASE_PATH}/`);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Classes" })
    .click();
  await expect(page.getByRole("heading", { name: "Classes" })).toBeVisible();
});
