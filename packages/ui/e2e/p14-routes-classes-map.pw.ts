import type { Server } from "node:http";
import { expect, test } from "@playwright/test";

import { watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { generatedRoutes } from "./mock-stats.ts";
import { BASE_PATH, startServer } from "./serve.ts";

// Phase 14, P14-03: the Routes, Classes and Map pages in the kit's look.
let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash: string) => `${origin}${BASE_PATH}/#/${hash}`;
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
  test(`routes in ${scheme} mode: tiles, slowest bars, table (screenshot)`, async ({
    page,
  }) => {
    // Routes with different p95s and a previous window, so the bars and changes have something to show.
    mock.routeStats = (minutes) => {
      const response = generatedRoutes(minutes);
      response.routes.forEach((r, i) => {
        r.p95Ms = [180, 95, 640, 30][i] ?? 30;
        r.p50Ms = r.p95Ms / 3;
        r.p99Ms = r.p95Ms * 1.6;
      });
      return response;
    };
    mock.routeCompare = (q) => ({
      mode: "window",
      windowMinutes: Number(q.get("windowMinutes") ?? 15),
      previous: { fromUnixMs: 0, toUnixMs: 1 },
      current: { fromUnixMs: 1, toUnixMs: 2 },
      previousCovered: true,
      note: null,
      releases: [],
      routes: generatedRoutes(15).routes.map((r, i) => {
        const p95 = [180, 95, 640, 30][i] ?? 30;
        const before = {
          count: r.count,
          errors: 0,
          p50Ms: 5,
          p95Ms: [120, 110, 700, 30][i] ?? 30,
        };
        const after = {
          count: r.count + 10,
          errors: r.errors,
          p50Ms: 5,
          p95Ms: p95,
        };
        return {
          method: r.method,
          route: r.route,
          before,
          after,
          delta: {
            count: 10,
            errorRate: r.count > 0 ? r.errors / r.count : 0,
            p50Ms: 0,
            p95Ms: p95 - before.p95Ms,
          },
        };
      }),
    });
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("routes?method=GET&route=%2Forders%2F%3Aid"));
    await expect(page.getByTestId("route-row").first()).toBeVisible();
    await expect(page.getByTestId("page-header")).toContainText("Routes");
    await expect(
      page.getByTestId("kpi-strip").getByTestId("kpi-value"),
    ).toHaveCount(4);
    await expect(page.getByTestId("chart-top-p95")).toBeVisible();
    // The worst p95 fell from 700 ms to 640 ms against the previous window: better.
    await expect(
      page.getByTestId("kpi-worst-p95").getByTestId("kpi-value"),
    ).toHaveText("640");
    await expect(
      page.getByTestId("kpi-worst-p95").getByTestId("delta"),
    ).toHaveAttribute("data-tone", "better");
    await expect(
      page.getByTestId("kpi-worst-p95").getByTestId("delta"),
    ).toContainText("-60");
    await expect(page.getByTestId("route-detail")).toBeVisible();
    await expect(
      page.getByTestId("chart-latency").locator("canvas"),
    ).toBeVisible();
    await page.screenshot({
      path: `${SHOTS}/p14-routes-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });

  test(`classes in ${scheme} mode: tiles, kind donut, table (screenshot)`, async ({
    page,
  }) => {
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("classes"));
    await expect(page.getByTestId("class-row")).toHaveCount(4);
    await page
      .getByTestId("class-row")
      .filter({ hasText: "OrdersService" })
      .click({ position: { x: 600, y: 10 } });
    await expect(page.getByTestId("method-row")).toHaveCount(3);
    await page.screenshot({
      path: `${SHOTS}/p14-classes-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });

  test(`map in ${scheme} mode: coloured nodes, legend, side panel (screenshot)`, async ({
    page,
  }) => {
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("map"));
    await expect(page.getByTestId("map-node")).toHaveCount(5);
    await page.getByTestId("map-node-button").nth(3).click();
    await expect(page.getByTestId("map-panel")).toBeVisible();
    await page.screenshot({
      path: `${SHOTS}/p14-map-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("routes: the table shows the change against the previous window, and a row click selects", async ({
  page,
}) => {
  mock.routeStats = generatedRoutes;
  await page.goto(url("routes"));
  const rows = page.getByTestId("route-row");
  await expect(rows.first()).toBeVisible();
  // The mock has no previous window for routes: the change is an honest dash.
  await expect(rows.first().getByTestId("delta")).toHaveAttribute(
    "data-tone",
    "unknown",
  );
  await expect(
    page.getByTestId("kpi-rate").getByTestId("delta"),
  ).toHaveAttribute("data-tone", "unknown");
  // The p95 bars are scaled to the slowest route.
  const pcts = await rows
    .locator("td:nth-child(6) [data-pct]")
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pct"))));
  expect(Math.max(...pcts)).toBe(100);
  // A click on a cell that is not a link or a button selects the route.
  await rows.first().locator("td").nth(4).click();
  await expect(page.getByTestId("route-detail")).toBeVisible();
  await expect(page).toHaveURL(/route=/);
  // The Details link still goes to the route page, not to a selection.
  await rows.first().getByTestId("route-details-link").click();
  await expect(page).toHaveURL(/#\/route\?/);
});

test("classes: the donut shares add up and the legend says the basis", async ({
  page,
}) => {
  await page.goto(url("classes"));
  const slices = page.getByTestId("donut-kind-slice");
  // Own time: OrdersController 130, OrdersService 130+... groups with time only.
  await expect(slices.first()).toBeVisible();
  const fractions = await slices.evaluateAll((els) =>
    els.map((e) => Number(e.getAttribute("data-fraction"))),
  );
  expect(fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
  await expect(page.getByTestId("card-kind-share")).toContainText(
    "Own time by kind",
  );
  await expect(page.getByTestId("legend-kind-row").first()).toContainText(
    "Controllers",
  );
});

test("map: selecting a node fills the side panel, and edge width follows call volume", async ({
  page,
}) => {
  await page.goto(url("map"));
  await expect(page.getByTestId("map-panel-empty")).toBeVisible();
  const stripe = page.locator("[data-testid=map-node][data-kind=http]").first();
  // Stripe: 4 of 20 calls failed and p95 is 900 ms.
  await expect(stripe).toHaveAttribute("data-health", "failing");
  await expect(
    page.locator("[data-testid=map-node][data-kind=database]"),
  ).toHaveAttribute("data-health", "ok");
  await stripe.click();
  const panel = page.getByTestId("map-panel");
  await expect(panel).toContainText("api.stripe.com");
  await expect(panel).toContainText("failing");
  await expect(panel).toContainText("20%");
  await expect(panel.getByTestId("map-panel-link")).toHaveAttribute(
    "href",
    /dependencies\?windowMinutes=15&name=api\.stripe\.com/,
  );
  // Clicking it again clears the selection.
  await stripe.click();
  await expect(page.getByTestId("map-panel")).toHaveCount(0);

  // The busiest edge (postgres, 120 calls... or redis, 300) is the widest line.
  const widths = await page
    .getByTestId("map-edge")
    .evaluateAll((lines) =>
      lines.map((l) => [
        Number(l.getAttribute("data-calls")),
        Number(l.getAttribute("stroke-width")),
      ]),
    );
  const busiest = widths.reduce((a, b) => (b[0] > a[0] ? b : a));
  const quietest = widths.reduce((a, b) => (b[0] < a[0] ? b : a));
  expect(busiest[1]).toBe(6);
  expect(quietest[1]).toBeLessThan(busiest[1] as number);
});

test("routes, classes and map do not scroll sideways on a phone", async ({
  page,
}) => {
  mock.routeStats = generatedRoutes;
  await page.setViewportSize({ width: 390, height: 800 });
  for (const hash of ["routes", "classes", "map"]) {
    await page.goto(url(hash));
    await expect(page.getByTestId("page-header")).toBeVisible();
    await expect(page.getByTestId("kpi-strip")).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, hash).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `${SHOTS}/p14-${hash}-phone.png`,
      fullPage: true,
    });
  }
});
