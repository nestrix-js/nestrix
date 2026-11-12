import type { Server } from "node:http";
import { expect, test } from "@playwright/test";

import { requestRows, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

// Phase 14: the shared kit, the shell and the Requests reference page.
let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/${hash}`;
const SHOTS = "test-results";

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

for (const scheme of ["dark", "light"] as const) {
  test(`requests in ${scheme} mode: tiles, timeline and rows (screenshot)`, async ({
    page,
  }) => {
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("requests"));
    await expect(requestRows(page).first()).toBeVisible();
    await expect(page.getByTestId("timeline")).toHaveAttribute(
      "data-buckets",
      "15",
    );
    await expect(page.getByTestId("timeline").locator("canvas")).toHaveCount(1);

    // The header, then four tiles built from what the page loads.
    await expect(page.getByTestId("page-header")).toContainText("Requests");
    await expect(
      page.getByTestId("kpi-strip").getByTestId("kpi-value"),
    ).toHaveCount(4);
    await expect(
      page.getByTestId("kpi-requests").getByTestId("kpi-value"),
    ).not.toHaveText("");
    // The API gives no previous window here, so the change is an honest dash.
    await expect(
      page.getByTestId("kpi-requests").getByTestId("delta"),
    ).toHaveAttribute("data-tone", "unknown");
    // The slowest request links to its trace.
    await expect(page.getByTestId("kpi-slowest-link")).toHaveAttribute(
      "href",
      /\/traces\/[0-9a-f]{32}$/,
    );

    // Dark and light really differ; the tokens switch with the scheme.
    const background = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(background).toBe(
      scheme === "dark" ? "oklch(0.145 0 0)" : "oklch(1 0 0)",
    );
    await page.screenshot({
      path: `${SHOTS}/p14-requests-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("a row opens its trace when clicked outside its links", async ({
  page,
}) => {
  await page.goto(url("requests"));
  await expect(requestRows(page).first()).toBeVisible();
  // Click the spans cell, which is not a link.
  await requestRows(page).first().locator("td").nth(5).click();
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toMatch(/^#\/traces\/[0-9a-f]{32}/);
});

test("the table header stays in view while the rows scroll inside their card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto(url("requests"));
  await expect(requestRows(page)).toHaveCount(50);
  const box = page.getByTestId("requests").locator("..");
  await box.evaluate((el) => {
    el.scrollTop = 400;
  });
  const header = page.getByTestId("requests").locator("thead th").first();
  const container = await box.boundingBox();
  const head = await header.boundingBox();
  if (!container || !head) throw new Error("no layout");
  // Scrolled, yet the header is still at the top of its box.
  expect(await box.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(Math.abs(head.y - container.y)).toBeLessThan(2);
});

test("phone width: no sideways page scroll, the section menu scrolls in its own box (screenshot)", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("requests"));
  await expect(requestRows(page).first()).toBeVisible();
  await expect(page.getByTestId("timeline").locator("canvas")).toHaveCount(1);

  const metrics = await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="section-menu"]');
    return {
      page: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      navScroll: nav?.scrollWidth ?? 0,
      navClient: nav?.clientWidth ?? 0,
    };
  });
  expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.navScroll).toBeGreaterThan(metrics.navClient);

  // The menu follows the current section: open a far one and it scrolls into view.
  await page.goto(url("dependencies"));
  await expect(
    page.getByRole("heading", { name: "Dependencies" }),
  ).toBeVisible();
  const link = page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Dependencies" });
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(link).toBeInViewport();

  await page.goto(url("requests"));
  await page.reload();
  // Only the fresh load counts: the reload itself aborts requests in flight.
  const problems = watch(page);
  await expect(requestRows(page).first()).toBeVisible();
  await expect(page.getByTestId("timeline").locator("canvas")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/p14-shell-phone.png` });
  expect(problems).toEqual([]);
});

test("keyboard focus is visible on the section menu", async ({ page }) => {
  await page.goto(url("requests"));
  await expect(requestRows(page).first()).toBeVisible();
  const first = page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link")
    .first();
  await first.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const outline = await first.evaluate(
    (el) => getComputedStyle(el).outlineStyle,
  );
  expect(outline).toBe("solid");
});
