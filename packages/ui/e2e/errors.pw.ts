import type { Server } from "node:http";
import type { ErrorGroupsResponse } from "@nestrix-js/protocol";
import { expect, type Page, test } from "@playwright/test";

import { loadFixtures } from "./fixtures.ts";
import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { generatedRoutes } from "./mock-stats.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
// The grouped view is the default; the list tests ask for the other one.
const url = (query = "") => `${origin}${BASE_PATH}/#/errors?view=all${query}`;
const groupsUrl = (hash = "") => `${origin}${BASE_PATH}/#/errors${hash}`;
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
  await expect(page).toHaveURL(/#\/errors\?view=all&route=\/orders$/);
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
  await page.goto(url("&route=%2Fnothing"));
  await expect(page.getByText("No errors for this route.")).toBeVisible();
});

// ---- grouped view (P9-04) ---------------------------------------------------------------------

const groupRows = (page: Page) =>
  page
    .getByTestId("error-groups")
    .locator("tbody tr[data-testid=error-group-row]");

function twoGroups(windowMinutes: number): ErrorGroupsResponse {
  const bucketMs = windowMinutes <= 15 ? 60_000 : 300_000;
  const buckets = windowMinutes <= 15 ? 15 : 12;
  const now = Date.now();
  const series = (counts: Record<number, number>) =>
    Array.from({ length: buckets }, (_, i) => counts[i] ?? 0);
  const recent = (n: number, count: number) =>
    Array.from({ length: Math.min(count, 10) }, (_, i) => ({
      traceId: idOf(n * 100 + i),
      spanId: idOf(n * 100 + i).slice(16),
      timeUnixMs: now - (i + 1) * 5000,
      message: `user ${n * 100 + i} not found`,
      service: i % 2 === 0 ? "api" : "billing",
    }));
  return {
    windowMinutes,
    bucketMs,
    fromUnixMs: now - windowMinutes * 60_000,
    toUnixMs: now,
    groups: [
      {
        key: "g1",
        errorType: "NotFoundException",
        pattern: "user <n> not found",
        route: "/users/:id",
        count: windowMinutes === 15 ? 12 : 40,
        firstSeenUnixMs: now - 600_000,
        lastSeenUnixMs: now - 5000,
        series: series({ 0: 2, [buckets - 1]: 10 }),
        services: ["api", "billing"],
        exampleTraceId: idOf(100),
        latestMessage: "user 100 not found",
        recent: recent(1, 12),
      },
      {
        key: "g2",
        errorType: "TimeoutError",
        pattern: "",
        count: 1,
        firstSeenUnixMs: now - 30_000,
        lastSeenUnixMs: now - 30_000,
        series: series({ [buckets - 1]: 1 }),
        services: [],
        exampleTraceId: idOf(200),
        recent: recent(2, 1),
      },
    ],
  };
}

test("grouped is the default view: counts, sparkline, times, route, sampled note", async ({
  page,
}) => {
  mock.errorGroups = twoGroups;
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(groupsUrl());
  await expect(page.getByRole("button", { name: "Grouped" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(groupRows(page)).toHaveCount(2);
  const first = groupRows(page).nth(0).locator("td");
  await expect(first.nth(0)).toHaveText("12");
  await expect(first.nth(1)).toContainText("NotFoundException");
  await expect(first.nth(1)).toContainText("user <n> not found");
  await expect(first.nth(2).getByTestId("sparkline")).toHaveAttribute(
    "aria-label",
    "12 in the last 15 minutes",
  );
  // One bar per non-empty bucket, scaled to the largest.
  await expect(first.nth(2).locator("rect")).toHaveCount(2);
  await expect(first.nth(3)).toHaveText(/ago|now/);
  await expect(first.nth(4)).toHaveText(/ago|now/);
  await expect(first.nth(5)).toHaveText("/users/:id");
  // A group without a route shows a dash.
  const second = groupRows(page).nth(1).locator("td");
  await expect(second.nth(5)).toHaveText("-");
  await expect(page.getByTestId("groups-note")).toContainText("sampled");
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
  // The list is not fetched while grouped.
  expect(mock.requests.some((r) => /^errors(\?|$)/.test(r))).toBe(false);
});

test("a group expands to its recent occurrences, which link to traces", async ({
  page,
}) => {
  mock.errorGroups = twoGroups;
  await page.goto(groupsUrl());
  const row = groupRows(page).first();
  await expect(page.getByTestId("error-group-detail")).toHaveCount(0);
  await row.getByRole("button").click();
  await expect(row.getByRole("button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const detail = page.getByTestId("error-group-detail");
  await expect(detail).toContainText("Services: api, billing");
  await expect(detail.getByTestId("group-occurrence")).toHaveCount(10);
  await expect(detail.getByTestId("group-occurrence").first()).toContainText(
    "user 100 not found",
  );
  await detail
    .getByTestId("group-occurrence")
    .first()
    .getByRole("link", { name: "View trace" })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/traces/${idOf(100)}$`));
});

test("the window switches to 60 minutes and asks the server for it", async ({
  page,
}) => {
  mock.errorGroups = twoGroups;
  await page.goto(groupsUrl());
  await expect(groupRows(page).first().locator("td").nth(0)).toHaveText("12");
  await page.getByRole("button", { name: "60 min" }).click();
  await expect(groupRows(page).first().locator("td").nth(0)).toHaveText("40");
  await expect(
    groupRows(page).first().getByTestId("sparkline"),
  ).toHaveAttribute("aria-label", "40 in the last 60 minutes");
  expect(
    mock.requests.some((r) => /^errors\/groups\?windowMinutes=60/.test(r)),
  ).toBe(true);
});

test("the All toggle shows the list and back; an empty window says so; a failure can be retried", async ({
  page,
}) => {
  mock.errors.push(2);
  await page.goto(groupsUrl());
  await expect(
    page.getByText("No errors in the last 15 minutes."),
  ).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page).toHaveURL(/#\/errors\?view=all$/);
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Grouped" }).click();
  await expect(page).not.toHaveURL(/view=/);
  await expect(page.getByTestId("error-groups")).toBeVisible();

  mock.failing.add("errors/groups");
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Could not load error groups.",
  );
  mock.failing.clear();
  mock.errorGroups = twoGroups;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(groupRows(page)).toHaveCount(2);
});
