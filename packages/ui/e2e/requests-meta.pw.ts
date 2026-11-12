import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { requestRows } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/${hash}`;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset(0);
});

const headers = (page: Page) =>
  page.getByTestId("requests").locator("thead th").allTextContents();

test("release and user columns show when some item has them", async ({
  page,
}) => {
  mock.push(6); // releases on all, users on every third
  await page.goto(url());
  await expect(requestRows(page)).toHaveCount(6);
  const names = (await headers(page)).map((h) => h.trim());
  expect(names).toContain("Release");
  expect(names).toContain("User");
  const first = requestRows(page).first(); // seq 6: release 1.4.2, user u-6
  await expect(first.locator("td").nth(7)).toHaveText("1.4.2");
  await expect(first.locator("td").nth(8)).toHaveText("u-6");
  // seq 5 has a release but no user.
  await expect(requestRows(page).nth(1).locator("td").nth(8)).toHaveText("-");
});

test("the columns are hidden when no item has a release or a user", async ({
  page,
}) => {
  mock.push(4, { release: undefined, user: undefined });
  await page.goto(url());
  await expect(requestRows(page)).toHaveCount(4);
  const names = (await headers(page)).map((h) => h.trim());
  expect(names).not.toContain("Release");
  expect(names).not.toContain("User");
  expect(names).toContain("Error");
});

test("only the user column hides when no item has a user", async ({ page }) => {
  mock.push(4, { user: undefined });
  await page.goto(url());
  await expect(requestRows(page)).toHaveCount(4);
  const names = (await headers(page)).map((h) => h.trim());
  expect(names).toContain("Release");
  expect(names).not.toContain("User");
});

test("type filter: All, HTTP, Jobs and Scheduled go to the URL and the request", async ({
  page,
}) => {
  mock.push(3);
  mock.push(2, { type: "job", method: undefined, route: undefined });
  mock.push(1, { type: "scheduled", method: undefined, route: undefined });
  await page.goto(url());
  await expect(requestRows(page)).toHaveCount(6);

  const select = page.getByTestId("type-filter");
  await select.selectOption("job");
  await expect(requestRows(page)).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toContain("type=job");
  expect(mock.traceRequests().at(-1)?.get("type")).toBe("job");

  await select.selectOption("scheduled");
  await expect(requestRows(page)).toHaveCount(1);
  await select.selectOption("http");
  await expect(requestRows(page)).toHaveCount(3);
  await select.selectOption("");
  await expect(requestRows(page)).toHaveCount(6);
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .not.toContain("type=");
});

test("job badge, and the Jobs filter matches traces with job processing (any root)", async ({
  page,
}) => {
  mock.push(2); // plain requests
  mock.push(1, { hasJob: true }); // a request that enqueued a job: type http, hasJob true
  mock.push(1, { type: "job", method: undefined, route: undefined });
  await page.goto(url());
  await expect(requestRows(page)).toHaveCount(4);
  await expect(page.getByTestId("job-badge")).toHaveCount(2);

  const select = page.getByTestId("type-filter");
  await expect(select.locator("option[value=job]")).toHaveAttribute(
    "title",
    "Traces with job processing",
  );
  await select.selectOption("job");
  await expect(requestRows(page)).toHaveCount(2);
  await expect(page.getByTestId("job-badge")).toHaveCount(2);
  // The request that enqueued the job is also an HTTP request.
  await select.selectOption("http");
  await expect(requestRows(page)).toHaveCount(3);
  await expect(page.getByTestId("job-badge")).toHaveCount(1);
});

test("release and user filters match exactly and live in the URL", async ({
  page,
}) => {
  mock.push(6); // releases alternate 1.4.1 / 1.4.2; users u-3 and u-6 on seq 3 and 6
  await page.goto(url());
  await expect(requestRows(page)).toHaveCount(6);

  await page.getByLabel("Release", { exact: true }).fill("1.4.2");
  await expect(requestRows(page)).toHaveCount(3);
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toContain("release=1.4.2");
  // A prefix is not a match.
  await page.getByLabel("Release", { exact: true }).fill("1.4");
  await expect(
    page.getByText("No requests match these filters."),
  ).toBeVisible();

  await page.getByLabel("Release", { exact: true }).fill("");
  // The list reloads (and its toolbar is rebuilt) before the next input is typed into.
  await expect(requestRows(page)).toHaveCount(6);
  await page.getByLabel("User", { exact: true }).fill("u-3");
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toContain("user=u-3");
  await expect(requestRows(page)).toHaveCount(1);
  await expect(requestRows(page).first().locator("td").nth(8)).toHaveText(
    "u-3",
  );
  expect(mock.traceRequests().at(-1)?.get("user")).toBe("u-3");
});

test("the filters are restored from the URL", async ({ page }) => {
  mock.push(2, { type: "job", release: "9.9.9", user: "alice" });
  mock.push(3);
  await page.goto(url("#/?type=job&release=9.9.9&user=alice"));
  await expect(requestRows(page)).toHaveCount(2);
  await expect(page.getByTestId("type-filter")).toHaveValue("job");
  await expect(page.getByLabel("Release", { exact: true })).toHaveValue(
    "9.9.9",
  );
  await expect(page.getByLabel("User", { exact: true })).toHaveValue("alice");
});
