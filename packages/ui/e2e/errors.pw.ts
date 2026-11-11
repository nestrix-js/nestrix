import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { loadFixtures } from "./fixtures.ts";
import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { generatedRoutes } from "./mock-stats.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/errors${hash}`;
const POLL = { timeout: 10_000 };
const rows = (page: Page) =>
  page.getByTestId("errors").locator("tbody tr[data-testid=error-row]");
const idOf = (seq: number) => seq.toString(16).padStart(32, "0");
const traceIds = (page: Page) =>
  rows(page)
    .locator("a")
    .evaluateAll((links) => links.map((a) => a.getAttribute("title") ?? ""));

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

test("renders the protocol fixture: every column, newest first, link to the trace", async ({
  page,
}) => {
  const { errorList } = await loadFixtures();
  mock.errors.fixed = errorList;
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await expect(rows(page)).toHaveCount(2);
  const first = rows(page).nth(0).locator("td");
  await expect(first.nth(0)).toHaveText(/ago|now|\d+ (day|year)s? ago|in /);
  await expect(first.nth(1)).toContainText("BadGatewayException");
  await expect(first.nth(1)).toContainText("GET /orders/:id");
  await expect(first.nth(2)).toHaveText("Payments service unavailable");
  await expect(first.nth(3)).toHaveText("/orders/:id");
  const link = first.nth(4).getByRole("link", { name: "View trace" });
  await expect(link).toHaveAttribute(
    "href",
    /#\/traces\/0af7651916cd43dd8448eb211c80319c$/,
  );
  // The second error is an internal span without a route.
  const second = rows(page).nth(1).locator("td");
  await expect(second.nth(1)).toContainText("TimeoutError");
  await expect(second.nth(3)).toHaveText("-");
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);

  await link.click();
  await expect(page).toHaveURL(/#\/traces\/0af7651916cd43dd8448eb211c80319c$/);
});

test("a long message is one line and opens in full", async ({ page }) => {
  mock.errors.push(4); // seq 4 has the long message
  await page.goto(url());
  const row = rows(page).first();
  const message = row.getByTestId("error-message");
  const full = (await message.textContent()) ?? "";
  expect(full.length).toBeGreaterThan(200);
  // One line: the cell is far shorter than the text would need on several lines.
  expect((await message.boundingBox())?.height ?? 99).toBeLessThan(30);
  await expect(page.getByTestId("error-detail")).toHaveCount(0);
  await row.getByRole("button").click();
  await expect(row.getByRole("button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByTestId("error-detail")).toContainText(full);
  await row.getByRole("button").click();
  await expect(page.getByTestId("error-detail")).toHaveCount(0);
});

test("an empty store says so", async ({ page }) => {
  await page.goto(url());
  await expect(page.getByText("No errors yet.")).toBeVisible();
});

test("a failed first load shows an error and can be retried", async ({
  page,
}) => {
  mock.failing.add("errors");
  await page.goto(url());
  await expect(page.getByRole("alert")).toContainText("Could not load errors.");
  mock.failing.clear();
  mock.errors.push(1);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(rows(page)).toHaveCount(1);
});

test("live head merges new errors on top without duplicates, even on overlapping polls", async ({
  page,
}) => {
  mock.errors.push(3);
  await page.goto(url());
  await expect(rows(page)).toHaveCount(3);
  expect(await traceIds(page)).toEqual([idOf(3), idOf(2), idOf(1)]);

  mock.errors.push(2);
  await expect.poll(async () => (await traceIds(page))[0], POLL).toBe(idOf(5));
  expect(await traceIds(page)).toEqual([
    idOf(5),
    idOf(4),
    idOf(3),
    idOf(2),
    idOf(1),
  ]);

  mock.errors.overlap = true; // each poll repeats the item at the cursor
  mock.errors.push(1);
  await expect.poll(async () => (await traceIds(page))[0], POLL).toBe(idOf(6));
  await page.waitForTimeout(2500);
  expect(await traceIds(page)).toEqual([6, 5, 4, 3, 2, 1].map(idOf));
  // Polls ask for what is newer than the head they hold.
  expect(mock.requests.some((r) => /^errors\?.*after=/.test(r))).toBe(true);
});

test("load older appends the next page until the store ends", async ({
  page,
}) => {
  mock.errors.push(120);
  await page.goto(url());
  await expect(rows(page)).toHaveCount(50);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(rows(page)).toHaveCount(100);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(rows(page)).toHaveCount(120);
  await expect(
    page.getByText("That is everything the store holds."),
  ).toBeVisible();
  const ids = await traceIds(page);
  expect(new Set(ids).size).toBe(120);
  expect(ids[0]).toBe(idOf(120));
  expect(ids[119]).toBe(idOf(1));
});

test("the route filter lives in the URL and filters the list", async ({
  page,
}) => {
  mock.errors.push(30);
  mock.routeStats = generatedRoutes;
  await page.goto(url());
  await expect(rows(page)).toHaveCount(30);
  await page.getByLabel("Route").selectOption("/orders");
  await expect(page).toHaveURL(/#\/errors\?route=\/orders$/);
  await expect(rows(page)).toHaveCount(10);
  for (const cell of await rows(page)
    .locator("td:nth-child(4)")
    .allTextContents())
    expect(cell).toBe("/orders");
  // The unmatched and overflow keys are not offered: no error can carry them.
  await expect(page.getByLabel("Route").locator("option")).toHaveText([
    "All routes",
    "/orders",
    "/orders/:id",
  ]);

  // A reload with the filter in the URL starts filtered.
  await page.reload();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByLabel("Route")).toHaveValue("/orders");

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(rows(page)).toHaveCount(30);
  await expect(page).not.toHaveURL(/route=/);
});

test("a route with no errors says so", async ({ page }) => {
  mock.errors.push(3);
  await page.goto(url("?route=%2Fnothing"));
  await expect(page.getByText("No errors for this route.")).toBeVisible();
});
