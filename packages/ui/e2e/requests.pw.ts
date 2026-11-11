import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

import { requestRows, rowTraceIds, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = () => `${origin}${BASE_PATH}/`;
const idOf = (seq: number) => seq.toString(16).padStart(32, "0");
// A poll is every 2 s; leave room for a slow browser.
const POLL = { timeout: 10_000 };

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

async function open(page: Page, hash = "") {
  const problems = watch(page);
  await page.goto(`${url()}${hash}`);
  await expect(requestRows(page).first()).toBeVisible();
  return problems;
}

test("list rendering: every column of a row, newest first", async ({
  page,
}) => {
  const problems = await open(page);
  const first = requestRows(page).first();
  // seq 120: GET /orders, a 500 (error), 5 + (120 * 7 % 300) = 245 ms, 1 span.
  const cells = first.locator("td");
  await expect(cells.nth(0)).toHaveText(/now|ago/);
  await expect(cells.nth(1)).toHaveText("GET");
  await expect(cells.nth(2)).toHaveText("/orders");
  await expect(cells.nth(3)).toHaveText("500");
  await expect(cells.nth(4)).toHaveText("245 ms");
  await expect(cells.nth(5)).toHaveText("1");
  await expect(cells.nth(6)).toHaveText("error");
  expect((await rowTraceIds(page))[0]).toBe(idOf(120));
  // seq 119 is newer-than-120's neighbour: not an error, not a 4xx.
  await expect(requestRows(page).nth(1).locator("td").nth(6)).toHaveText("-");
  expect(problems).toEqual([]);
});

test("loading shows a skeleton, then the rows", async ({ page }) => {
  mock.delayMs = 1000;
  await page.goto(url());
  await expect(page.getByTestId("table-skeleton")).toBeVisible();
  await expect(requestRows(page)).toHaveCount(50);
  await expect(page.getByTestId("table-skeleton")).toHaveCount(0);
});

test("empty store and empty filter result have their own messages", async ({
  page,
}) => {
  mock.reset(0);
  await page.goto(url());
  await expect(page.getByText("No requests yet.")).toBeVisible();
  await page.goto(`${url()}#/?search=nothing-matches-this`);
  await page.reload();
  await expect(
    page.getByText("No requests match these filters."),
  ).toBeVisible();
});

test("a failed first load shows an error and can be retried", async ({
  page,
}) => {
  mock.failing.add("traces");
  await page.goto(url());
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Could not load requests");
  await expect(alert).toContainText("Mock failure");
  mock.failing.clear();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(requestRows(page)).toHaveCount(50);
});

test("polling prepends new items after the head and never duplicates", async ({
  page,
}) => {
  await open(page);
  await expect(requestRows(page)).toHaveCount(50);

  mock.push(3);
  await expect(requestRows(page)).toHaveCount(53, POLL);
  const ids = await rowTraceIds(page);
  expect(ids.slice(0, 3)).toEqual([idOf(123), idOf(122), idOf(121)]);
  // The poll asked for what is newer than the head it knew.
  expect(
    mock
      .traceRequests()
      .some((q) => q.get("after") === `c${mock.epoch}.120` && !q.has("before")),
  ).toBe(true);

  // A poll that answers with an item already held (a retry, a race) adds nothing twice.
  mock.overlap = true;
  mock.push(2);
  await expect(requestRows(page)).toHaveCount(55, POLL);
  const polls = mock.traceRequests().length;
  await expect
    .poll(() => mock.traceRequests().length, POLL)
    .toBeGreaterThan(polls + 1);
  await expect(requestRows(page)).toHaveCount(55);
  const all = await rowTraceIds(page);
  expect(new Set(all).size).toBe(all.length);
});

test("load older appends the next page until the store ends", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(requestRows(page)).toHaveCount(100);
  // Pages are 50 items: the first ended at seq 71, so the next starts after it.
  expect(
    mock.traceRequests().some((q) => q.get("before") === `c${mock.epoch}.71`),
  ).toBe(true);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(requestRows(page)).toHaveCount(120);
  await expect(page.getByRole("button", { name: "Load older" })).toHaveCount(0);
  await expect(
    page.getByText("That is everything the store holds."),
  ).toBeVisible();
  const ids = await rowTraceIds(page);
  expect(new Set(ids).size).toBe(120);
  expect(ids[0]).toBe(idOf(120));
  expect(ids.at(-1)).toBe(idOf(1));
});

test("a failed load older keeps the list and can be retried", async ({
  page,
}) => {
  await open(page);
  mock.failing.add("traces");
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load older");
  await expect(requestRows(page)).toHaveCount(50);
  mock.failing.clear();
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(requestRows(page)).toHaveCount(100);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("reset on a poll clears the list and starts from the newest", async ({
  page,
}) => {
  await open(page);
  const before = await rowTraceIds(page);
  mock.restart(10);
  await expect(requestRows(page)).toHaveCount(10, POLL);
  const after = await rowTraceIds(page);
  expect(after.some((id) => before.includes(id))).toBe(false);
  expect(after[0]).toBe(idOf(10));
  // The next poll uses the new head, not the dead cursor.
  mock.push(1);
  await expect(requestRows(page)).toHaveCount(11, POLL);
});

test("reset on load older replaces the list", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Pause live" }).click();
  mock.restart(10);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(requestRows(page)).toHaveCount(10);
  expect((await rowTraceIds(page))[0]).toBe(idOf(10));
});

test("Reload drops everything held and loads the newest page", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Pause live" }).click();
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(requestRows(page)).toHaveCount(100);
  mock.push(2);
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(requestRows(page)).toHaveCount(50);
  expect((await rowTraceIds(page))[0]).toBe(idOf(122));
  const last = mock.traceRequests().at(-1);
  expect(last?.has("after")).toBe(false);
  expect(last?.has("before")).toBe(false);
});

test("pause live stops polling and is remembered; resume catches up", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Pause live" }).click();
  await expect(
    page.getByRole("button", { name: "Resume live" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "paused",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("nestrix.pauseLive")),
  ).toBe("1");
  await page.waitForTimeout(500);
  const count = mock.requests.length;
  mock.push(2);
  await page.waitForTimeout(4500);
  expect(mock.requests.length).toBe(count);
  await expect(requestRows(page)).toHaveCount(50);

  // The choice survives a reload; the first load still happens.
  await page.reload();
  await expect(requestRows(page).first()).toBeVisible();
  // The first page is the newest 50 of 122, so it already holds the two pushed while paused.
  expect((await rowTraceIds(page))[0]).toBe(idOf(122));
  await expect(page.getByRole("button", { name: "Resume live" })).toBeVisible();

  await page.getByRole("button", { name: "Resume live" }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("nestrix.pauseLive")),
  ).toBeNull();
  mock.push(1);
  await expect
    .poll(async () => (await rowTraceIds(page))[0], POLL)
    .toBe(idOf(123));
});

test("polling pauses while the tab is hidden and resumes when visible", async ({
  page,
}) => {
  await open(page);
  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((s) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => s,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => s === "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);

  await setVisibility("hidden");
  await page.waitForTimeout(500);
  const count = mock.requests.length;
  mock.push(2);
  await page.waitForTimeout(4500);
  expect(mock.requests.length).toBe(count);
  await expect(requestRows(page)).toHaveCount(50);

  await setVisibility("visible");
  await expect(requestRows(page)).toHaveCount(52, POLL);
});

test("the pause toggle works when localStorage is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const fail = () => {
      throw new Error("storage blocked");
    };
    Storage.prototype.getItem = fail;
    Storage.prototype.setItem = fail;
    Storage.prototype.removeItem = fail;
  });
  const problems = await open(page);
  await page.getByRole("button", { name: "Pause live" }).click();
  await expect(page.getByRole("button", { name: "Resume live" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("connection state follows the server", async ({ page }) => {
  await open(page);
  const connection = page.getByTestId("connection");
  await expect(connection).toHaveAttribute("data-state", "live");
  mock.failing.add("meta");
  await expect(connection).toHaveAttribute("data-state", "disconnected", POLL);
  mock.failing.clear();
  await expect(connection).toHaveAttribute("data-state", "live", POLL);
});

test("the sampling notice follows meta.sampling", async ({ page }) => {
  const notice = page.getByTestId("sampling-notice");
  await open(page);
  await expect(notice).toHaveText("lists are sampled");

  mock.sampling = { owner: "host", rate: null };
  await page.reload();
  await expect(notice).toHaveText("lists may be sampled");

  mock.sampling = { owner: "nestrix", rate: 1 };
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(notice).toHaveCount(0);
});

test("navigation reaches the other sections", async ({ page }) => {
  await open(page);
  await page.getByRole("link", { name: "Errors" }).click();
  await expect(page.getByRole("heading", { name: "Errors" })).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("#/errors");
  await page.getByRole("link", { name: "Routes" }).click();
  await expect(page.getByRole("heading", { name: "Routes" })).toBeVisible();
  await page.getByRole("link", { name: "Requests" }).click();
  await expect(requestRows(page).first()).toBeVisible();
});

test("the production bundle holds no fixture data", () => {
  const assets = fileURLToPath(new URL("../dist/assets/", import.meta.url));
  const js = readdirSync(assets).filter((f) => f.endsWith(".js"));
  expect(js.length).toBeGreaterThan(0);
  for (const file of js) {
    const text = readFileSync(`${assets}${file}`, "utf8");
    expect(text).not.toContain("orders-api");
    expect(text).not.toContain("0af7651916cd43dd8448eb211c80319c");
  }
});
