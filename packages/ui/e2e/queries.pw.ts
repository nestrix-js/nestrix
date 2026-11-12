import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { LONG_SQL, TRACE_B } from "./mock-queries.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/queries${hash}`;
const rows = (page: Page) => page.getByTestId("query-row");
const firstCells = (page: Page) =>
  rows(page).evaluateAll((trs) =>
    trs.map((tr) => tr.querySelector("td:nth-child(2)")?.textContent?.trim()),
  );

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

test("renders statements by total time, says it is built from sampled traces", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await expect(rows(page)).toHaveCount(3);
  expect(await firstCells(page)).toEqual(["postgresql", "postgresql", "redis"]);
  const user = rows(page).filter({ hasText: "FROM users" });
  const cells = user.locator("td");
  await expect(cells.nth(2)).toHaveText("100");
  await expect(cells.nth(3)).toHaveText("500 ms");
  await expect(cells.nth(5)).toHaveText("9.0 ms");
  await expect(cells.nth(7)).toHaveText("2");
  // Calls per trace (100 calls in 8 traces) and the N+1 badge (6 traces repeated it).
  await expect(cells.nth(8)).toHaveText("13");
  await expect(cells.nth(9)).toHaveText("6 traces");
  await expect(page.getByTestId("sampled-note")).toContainText(
    "sampled traces",
  );
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("sorting by a column asks the API and is kept in the URL", async ({
  page,
}) => {
  await page.goto(url());
  await page.getByTestId("sort-count").click();
  await expect(rows(page).nth(0)).toContainText("GET session:?");
  await expect(page.locator("th[aria-sort='descending']")).toHaveText("Count");
  await expect(page).toHaveURL(/sort=count/);
  expect(mock.requests.some((r) => r.includes("sort=count"))).toBe(true);
  await page.reload();
  await expect(rows(page).nth(0)).toContainText("GET session:?");
});

test("the N+1 filter keeps statements repeated within a trace", async ({
  page,
}) => {
  await page.goto(url());
  await page.getByTestId("nplus-filter").click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).nth(0)).toContainText("FROM users");
  await expect(page).toHaveURL(/nplus=true/);
  await page.getByTestId("nplus-filter").click();
  await expect(rows(page)).toHaveCount(3);
});

test("a long statement is cut, in monospace, and expands to its full text", async ({
  page,
}) => {
  await page.goto(url());
  const long = rows(page).filter({ hasText: "FROM orders" });
  const text = long.getByTestId("statement");
  await expect(text).toHaveCSS("font-family", /mono/i);
  await expect(text).toContainText("…");
  await expect(text).not.toContainText("LIMIT ?");
  await text.click();
  await expect(text).toHaveAttribute("aria-expanded", "true");
  await expect(text).toContainText(LONG_SQL);
  await text.click();
  await expect(text).toContainText("…");
});

test("the example trace link opens that trace", async ({ page }) => {
  await page.goto(url());
  await rows(page)
    .filter({ hasText: "FROM orders" })
    .getByTestId("example-trace")
    .click();
  await expect(page).toHaveURL(new RegExp(`#/traces/${TRACE_B}$`));
});

test("the window toggle asks the API for 60 minutes", async ({ page }) => {
  await page.goto(url());
  await page.getByRole("button", { name: "60 min", exact: true }).click();
  await expect(page).toHaveURL(/windowMinutes=60/);
  expect(mock.requests.some((r) => r.includes("windowMinutes=60"))).toBe(true);
});

test("a failing API shows an error with a retry", async ({ page }) => {
  (mock.failing as Set<string>).add("queries");
  await page.goto(url());
  await expect(page.getByRole("alert")).toContainText("Could not load queries");
  mock.failing.clear();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(rows(page)).toHaveCount(3);
});
