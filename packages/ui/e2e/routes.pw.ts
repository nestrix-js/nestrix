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
const url = (hash = "") => `${origin}${BASE_PATH}/#/routes${hash}`;
const rows = (page: Page) => page.getByTestId("route-row");
const windowButton = (page: Page, minutes: number) =>
  page.getByRole("button", { name: `${minutes} min`, exact: true });
const asked = () =>
  mock.requests
    .filter((r) => r.startsWith("routes?"))
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

test("renders the protocol fixture sorted by request count, with rates and percentiles", async ({
  page,
}) => {
  const { routes } = await loadFixtures();
  mock.routeStats = () => routes;
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await expect(rows(page)).toHaveCount(2);
  // /orders/:id has 140 requests and /orders 12: busiest first.
  const first = rows(page).nth(0).locator("td");
  await expect(first.nth(0)).toHaveText("GET");
  await expect(first.nth(1)).toHaveText("/orders/:id");
  await expect(first.nth(2)).toHaveText("140");
  await expect(first.nth(3)).toHaveText("4.3%"); // 6 of 140
  await expect(first.nth(4)).toHaveText("18.2 ms");
  await expect(first.nth(5)).toHaveText("96.4 ms");
  await expect(first.nth(6)).toHaveText("182 ms");
  const second = rows(page).nth(1).locator("td");
  await expect(second.nth(1)).toHaveText("/orders");
  await expect(second.nth(3)).toHaveText("0%");
  await expect(page.getByTestId("route-detail")).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("(unmatched) and (other) are explained, not shown raw", async ({
  page,
}) => {
  mock.routeStats = generatedRoutes;
  await page.goto(url());
  await expect(rows(page)).toHaveCount(4);
  const unmatched = rows(page).filter({ hasText: "(unmatched)" });
  await expect(unmatched).toContainText("requests that matched no route");
  const other = rows(page).filter({ hasText: "(other)" });
  await expect(other.locator("td").nth(0)).toHaveText("any");
  await expect(other).toContainText("past the 500");
  // Selecting one still draws its charts.
  await unmatched.getByRole("button").click();
  await expect(page.getByTestId("route-detail")).toContainText("(unmatched)");
  await expect(
    page.getByTestId("chart-latency").locator("canvas"),
  ).toBeVisible();
});

test("selecting a route draws both charts; the selection is in the URL and survives a reload", async ({
  page,
}) => {
  mock.routeStats = generatedRoutes;
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await rows(page)
    .filter({ hasText: "/orders/:id" })
    .getByRole("button")
    .click();
  await expect(page).toHaveURL(/#\/routes\?route=\/orders\/:id&method=GET$/);
  const detail = page.getByTestId("route-detail");
  await expect(detail).toContainText("last 15 minutes");
  for (const [id, labels] of [
    ["chart-latency", ["p50", "p95"]],
    ["chart-traffic", ["requests", "errors"]],
  ] as const) {
    const chart = page.getByTestId(id);
    await expect(chart.locator("canvas")).toBeVisible();
    await expect(chart.locator(".u-legend .u-series th")).toContainText([
      "",
      ...labels,
    ]);
  }
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);

  await page.reload();
  await expect(page.getByTestId("route-detail")).toContainText("/orders/:id");
  // Selecting the same route again clears it.
  await rows(page)
    .filter({ hasText: "/orders/:id" })
    .getByRole("button")
    .click();
  await expect(page.getByTestId("route-detail")).toHaveCount(0);
  await expect(page).not.toHaveURL(/route=/);
});

test("the window switch goes through the URL, the request and the chart", async ({
  page,
}) => {
  mock.routeStats = generatedRoutes;
  await page.goto(url("?method=GET&route=%2Forders%2F%3Aid"));
  await expect(page.getByTestId("route-detail")).toContainText(
    "last 15 minutes",
  );
  await expect(windowButton(page, 15)).toHaveAttribute("aria-pressed", "true");
  expect(asked()[0]).toBe("15");

  await windowButton(page, 60).click();
  await expect(page).toHaveURL(/windowMinutes=60/);
  await expect(page.getByTestId("route-detail")).toContainText(
    "last 60 minutes",
  );
  await expect(windowButton(page, 60)).toHaveAttribute("aria-pressed", "true");
  expect(asked()).toContain("60");
  // The route stays selected, and the chart holds 60 one-minute points: its x axis spans an hour.
  await expect(page.getByTestId("route-detail")).toContainText("/orders/:id");
  await expect(page.getByTestId("chart-traffic")).toHaveAttribute(
    "data-points",
    "60",
  );
  await expect(page.getByTestId("chart-latency")).toHaveAttribute(
    "data-points",
    "60",
  );

  // A reload keeps the window, and switching back to 15 drops it from the URL.
  await page.reload();
  await expect(windowButton(page, 60)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("chart-traffic")).toHaveAttribute(
    "data-points",
    "60",
  );
  await windowButton(page, 15).click();
  await expect(page).not.toHaveURL(/windowMinutes/);
  await expect(page.getByTestId("route-detail")).toContainText(
    "last 15 minutes",
  );
  await expect(page.getByTestId("chart-traffic")).toHaveAttribute(
    "data-points",
    "15",
  );

  // A window the API does not offer is ignored rather than sent.
  await page.goto(url("?windowMinutes=7"));
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  expect(asked().at(-1)).toBe("15");
  await expect(windowButton(page, 15)).toHaveAttribute("aria-pressed", "true");
});

test("the sampling note follows meta.sampling", async ({ page }) => {
  mock.routeStats = generatedRoutes;
  const note = page.getByTestId("statistics-note");
  await page.goto(url());
  await expect(rows(page).first()).toBeVisible();
  await expect(note).toContainText("count every request");
  await expect(note).toContainText("are sampled (25%");

  mock.sampling = { owner: "nestrix", rate: 1 };
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await expect(note).toHaveCount(0);

  mock.sampling = { owner: "host", rate: null };
  await page.reload();
  await expect(note).toContainText("may hold fewer");
});

test("an empty window and a failed load have their own states", async ({
  page,
}) => {
  mock.routeStats = (minutes) => ({
    ...generatedRoutes(minutes),
    routes: [],
  });
  await page.goto(url());
  await expect(
    page.getByText("No requests in the last 15 minutes."),
  ).toBeVisible();

  mock.failing.add("routes");
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Could not load route statistics.",
  );
  mock.failing.clear();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("No requests in the last 15 minutes."),
  ).toBeVisible();
});

test("charts follow the colour scheme", async ({ page }) => {
  mock.routeStats = generatedRoutes;
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(url("?method=GET&route=%2Forders%2F%3Aid"));
  const canvas = page.getByTestId("chart-traffic").locator("canvas").first();
  await expect(canvas).toBeVisible();
  const draw = () => canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL());
  const dark = await draw();
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(draw).not.toBe(dark);
});

test("a route with data in a single minute still draws its latency points", async ({
  page,
}) => {
  mock.routeStats = (windowMinutes) => {
    const response = generatedRoutes(windowMinutes);
    for (const route of response.routes) {
      route.series = route.series.map((point, i) =>
        i === windowMinutes - 3
          ? { ...point, count: 4, errors: 0, p50Ms: 20, p95Ms: 60 }
          : { timeUnixMs: point.timeUnixMs, count: 0, errors: 0 },
      );
    }
    return response;
  };
  await page.goto(url("?method=GET&route=%2Forders%2F%3Aid"));
  const canvas = page.getByTestId("chart-latency").locator("canvas").first();
  await expect(canvas).toBeVisible();
  // A line cannot draw one value, so the p95 colour (--chart-2) can only come from its marker.
  const pixels = () =>
    canvas.evaluate((el: HTMLCanvasElement) => {
      const probe = document.createElement("canvas").getContext("2d", {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D;
      probe.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue("--chart-2")
        .trim();
      probe.fillRect(0, 0, 1, 1);
      const want = probe.getImageData(0, 0, 1, 1).data;
      const { data } = (
        el.getContext("2d") as CanvasRenderingContext2D
      ).getImageData(0, 0, el.width, el.height);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i] === want[0] &&
          data[i + 1] === want[1] &&
          data[i + 2] === want[2] &&
          data[i + 3] === 255
        ) {
          n++;
        }
      }
      return n;
    });
  await expect.poll(pixels).toBeGreaterThan(5);
});
