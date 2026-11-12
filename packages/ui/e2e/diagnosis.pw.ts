import type { Server } from "node:http";
import type { TraceResponse } from "@nestrix-js/protocol";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, requestRows, violations } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { DB_TRACE_ID, dbTrace } from "./mock-db-trace.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

const spanId = (n: number) => n.toString(16).padStart(16, "0");

// dbTrace, with the handler (2) and the render span (8) made Nest methods of two classes.
const classed: TraceResponse = {
  ...dbTrace,
  spans: dbTrace.spans.map((s) =>
    s.spanId === spanId(2)
      ? {
          ...s,
          attributes: { ...s.attributes, "nestrix.class": "OrdersController" },
        }
      : s.spanId === spanId(8)
        ? {
            ...s,
            attributes: { ...s.attributes, "nestrix.class": "RenderService" },
          }
        : s,
  ),
};

async function openTrace(page: Page, trace: TraceResponse) {
  await recordViolations(page);
  await page.route("**/api/v1/trace?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(trace),
    }),
  );
  await page.goto(`${origin}${BASE_PATH}/#/traces/${DB_TRACE_ID}`);
  await expect(page.getByTestId("span-row").first()).toBeVisible();
}

test("Where the time went: stacked bar, legend with percentages, top classes and spans", async ({
  page,
}) => {
  await openTrace(page, classed);
  const summary = page.getByTestId("time-summary");
  await expect(summary).toBeVisible();
  // Own time (ms): root 10, handler 50.5, queries 279.5, render 60; 400 in all.
  const segments = summary.getByTestId("time-segment");
  expect(
    await segments.evaluateAll((els) =>
      els.map((el) => [
        el.getAttribute("data-category"),
        Math.round(Number(el.getAttribute("data-pct"))),
      ]),
    ),
  ).toEqual([
    ["database", 70],
    ["code", 28],
    ["other", 3],
  ]);
  const legend = summary.getByTestId("time-legend-item");
  await expect(legend).toHaveText([
    /Database\s*70%/,
    /Your code\s*28%/,
    /Other\s*3%/,
  ]);
  // The segment widths are what the percentages say.
  const widths = await segments.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().width),
  );
  const bar = await summary.getByTestId("time-bar").boundingBox();
  expect(widths[0] / (bar?.width ?? 1)).toBeCloseTo(0.7, 1);
  // Top items: the slow query, then the classes by their own time.
  const top = summary.getByTestId("time-top-item");
  await expect(top).toHaveCount(5);
  await expect(top.nth(0)).toContainText("SELECT orders");
  await expect(top.nth(1)).toContainText("SELECT orders");
  await expect(top.nth(2)).toContainText("RenderService");
  await expect(top.nth(3)).toContainText("OrdersController");
  expect(await violations(page)).toEqual([]);
});

test("critical path highlights the chain that ends the trace, and clears again", async ({
  page,
}) => {
  await openTrace(page, dbTrace);
  const critical = page.locator(
    '[data-testid="span-row"][data-critical="true"]',
  );
  await expect(critical).toHaveCount(0);
  const toggle = page.getByTestId("critical-path-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // Root, the handler, and the render span, which ends last (380 ms).
  expect(
    await critical.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-span-id")),
    ),
  ).toEqual([spanId(1), spanId(2), spanId(8)]);
  await toggle.click();
  await expect(critical).toHaveCount(0);
});

test("request rows carry a duration bar relative to the slowest row", async ({
  page,
}) => {
  await page.goto(`${origin}${BASE_PATH}/#/requests`);
  await expect(requestRows(page).first()).toBeVisible();
  const rows = await requestRows(page).evaluateAll((trs) =>
    trs.map((tr) => ({
      ms: Number.parseFloat(tr.querySelectorAll("td")[4]?.textContent ?? ""),
      pct: Number(
        tr
          .querySelector('[data-testid="duration-bar"]')
          ?.getAttribute("data-pct"),
      ),
    })),
  );
  expect(rows.length).toBe(50);
  const max = Math.max(...rows.map((r) => r.ms));
  expect(Math.max(...rows.map((r) => r.pct))).toBe(100);
  for (const row of rows) expect(row.pct).toBeCloseTo((row.ms / max) * 100, 0);
  // The drawn width follows the percentage.
  const widest = requestRows(page).getByTestId("duration-bar").first();
  const track = await widest.evaluate(
    (el) => el.parentElement?.getBoundingClientRect().width ?? 0,
  );
  const drawn = await widest.evaluate((el) => el.getBoundingClientRect().width);
  expect(drawn / track).toBeCloseTo(rows[0].pct / 100, 1);
});

test("saved filters: save, apply, survive a reload, delete; copy link", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "clipboard permissions are Chromium-only",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await recordViolations(page);
  await page.goto(
    `${origin}${BASE_PATH}/#/requests?status=error&minDurationMs=100`,
  );
  await expect(requestRows(page).first()).toBeVisible();

  // Nothing to save without a name; then save the current filters.
  await page.getByTestId("saved-filters-trigger").click();
  await expect(page.getByTestId("saved-filter-save")).toBeDisabled();
  await page.getByTestId("saved-filter-name").fill("slow errors");
  await page.getByTestId("saved-filter-save").click();
  await expect(page.getByTestId("saved-filter-item")).toHaveText(/slow errors/);
  await page.keyboard.press("Escape");

  // Reset the view, then apply the saved one.
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page).not.toHaveURL(/status=error/);
  mock.requests.length = 0;
  await page.getByTestId("saved-filters-trigger").click();
  await page.getByTestId("saved-filter-apply").click();
  await expect(page).toHaveURL(/status=error/);
  await expect(page).toHaveURL(/minDurationMs=100/);
  await expect
    .poll(() =>
      mock
        .traceRequests()
        .some(
          (q) =>
            q.get("status") === "error" && q.get("minDurationMs") === "100",
        ),
    )
    .toBe(true);

  // Copy link puts the filtered view's address on the clipboard.
  await page.getByTestId("copy-filter-link").click();
  await expect(page.getByTestId("copy-filter-link")).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    page.url(),
  );

  // The saved filter is still there after a reload, and can be deleted.
  await page.goto(`${origin}${BASE_PATH}/#/requests`);
  await page.reload();
  await expect(requestRows(page).first()).toBeVisible();
  await page.getByTestId("saved-filters-trigger").click();
  await expect(page.getByTestId("saved-filter-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Delete slow errors" }).click();
  await expect(page.getByTestId("saved-filter-item")).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});
