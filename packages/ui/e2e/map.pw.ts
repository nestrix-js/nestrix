import type { Server } from "node:http";
import { expect, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { mapEmpty } from "./mock-classes-map.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/map${hash}`;
const windowButton = (page: import("@playwright/test").Page, minutes: number) =>
  page.getByRole("button", { name: `${minutes} min`, exact: true });

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

test("draws the app in the centre with its targets, labelled edges and a sampling note", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  const nodes = page.getByTestId("map-node");
  await expect(nodes).toHaveCount(5);
  await expect(
    page.locator("[data-testid=map-node][data-kind=app]"),
  ).toContainText("demo-service");
  for (const kind of ["database", "cache", "http", "queue"])
    await expect(
      page.locator(`[data-testid=map-node][data-kind=${kind}]`),
    ).toHaveCount(1);
  await expect(page.getByTestId("map-edge")).toHaveCount(4);
  await expect(page.getByTestId("map-note")).toContainText("sampled traces");

  // The app node is in the middle of the drawing; the others are not.
  const svg = await page.getByTestId("map").boundingBox();
  const app = await page
    .locator("[data-testid=map-node][data-kind=app]")
    .boundingBox();
  if (!svg || !app) throw new Error("no boxes");
  expect(app.x + app.width / 2).toBeCloseTo(svg.x + svg.width / 2, -1);
  expect(app.y + app.height / 2).toBeCloseTo(svg.y + svg.height / 2, -1);

  // Edge labels carry calls, p95 and error rate.
  const labels = page.getByTestId("map-edge-label");
  await expect(labels.filter({ hasText: /^20 calls/ })).toContainText(
    "p95 900 ms · 20% err",
  );
  await expect(labels.filter({ hasText: /^120 calls/ })).toContainText(
    "p95 21.0 ms · 0% err",
  );
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("edge colour follows the error rate", async ({ page }) => {
  await page.goto(url());
  await expect(page.getByTestId("map-edge")).toHaveCount(4);
  const level = (n: string) =>
    page
      .getByTestId("map-edge")
      .evaluateAll(
        (lines, wanted) =>
          lines.filter((l) => l.getAttribute("data-level") === wanted).length,
        n,
      );
  expect(await level("none")).toBe(2); // postgres, queue
  expect(await level("low")).toBe(1); // redis: 1 of 300
  expect(await level("high")).toBe(1); // stripe: 4 of 20
  // The stroke actually differs, so the colour is on screen and not only in an attribute.
  const strokes = await page
    .getByTestId("map-edge")
    .evaluateAll((lines) =>
      lines.map((l) => [
        l.getAttribute("data-level"),
        getComputedStyle(l).stroke,
      ]),
    );
  const colour = (lvl: string) => strokes.find((s) => s[0] === lvl)?.[1];
  expect(colour("high")).not.toBe(colour("none"));
  expect(colour("low")).not.toBe(colour("high"));
});

test("the same edges are in a table below the drawing", async ({ page }) => {
  await page.goto(url());
  const rows = page.getByTestId("map-edge-row");
  await expect(rows).toHaveCount(4);
  const stripe = rows.filter({ hasText: "api.stripe.com" });
  const cells = stripe.locator("td");
  await expect(cells.nth(0)).toHaveText("demo-service");
  await expect(cells.nth(2)).toHaveText("20");
  await expect(cells.nth(3)).toHaveText("4");
  await expect(cells.nth(4)).toHaveText("20%");
  await expect(cells.nth(5)).toHaveText("180 ms");
  await expect(cells.nth(6)).toHaveText("900 ms");
  await expect(page.getByTestId("map")).toHaveAttribute("role", "img");
  await expect(page.getByTestId("map")).toHaveAttribute(
    "aria-label",
    /table below/,
  );
});

test("the 15 and 60 minute window toggle asks the API and is in the URL", async ({
  page,
}) => {
  await page.goto(url());
  await expect(
    page
      .getByTestId("map-edge-row")
      .filter({ hasText: "postgresql" })
      .locator("td")
      .nth(2),
  ).toHaveText("120");
  await windowButton(page, 60).click();
  await expect(
    page
      .getByTestId("map-edge-row")
      .filter({ hasText: "postgresql" })
      .locator("td")
      .nth(2),
  ).toHaveText("480");
  await expect(page).toHaveURL(/windowMinutes=60/);
  expect(
    mock.requests.filter((r) => r.startsWith("map?windowMinutes=60")),
  ).not.toHaveLength(0);
  await page.reload();
  await expect(windowButton(page, 60)).toHaveAttribute("aria-pressed", "true");
});

test("without any outgoing calls, the page says so instead of drawing", async ({
  page,
}) => {
  mock.appMap = mapEmpty;
  await page.goto(url());
  await expect(page.getByTestId("map-empty")).toContainText(
    "No calls to other services in the last 15 minutes.",
  );
  await expect(page.getByTestId("map")).toHaveCount(0);
  await expect(page.getByTestId("map-edge-row")).toHaveCount(0);
});

test("a failing API shows an error with a retry", async ({ page }) => {
  mock.failing.add("map");
  await page.goto(url());
  await expect(page.getByRole("alert")).toContainText(
    "Could not load the map.",
  );
  mock.failing.clear();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("map-node")).toHaveCount(5);
});

test("the navigation links to the map view", async ({ page }) => {
  await page.goto(`${origin}${BASE_PATH}/`);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Map" })
    .click();
  await expect(page.getByRole("heading", { name: "Map" })).toBeVisible();
});
