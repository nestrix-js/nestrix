// P9-02: the latency histogram of a route (click a bar to list its requests) and the Compare tab
// (window against the previous one, release against release). Mocked API.
import type { Server } from "node:http";
import type {
  CompareSide,
  RouteCompareResponse,
  RouteCompareRow,
  RouteHistogramResponse,
} from "@nestrix-js/protocol";
import { expect, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { generatedRoutes } from "./mock-stats.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/routes${hash}`;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
  mock.routeStats = generatedRoutes;
});

// The server's 30 log-spaced buckets: `<= 1 ms`, then 28 steps up to 60 s, then everything above.
const BOUNDS = Array.from({ length: 29 }, (_, i) => 60_000 ** (i / 28));
function histogram(
  counts: Record<number, number>,
  q: URLSearchParams,
): RouteHistogramResponse {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    method: q.get("method"),
    route: q.get("route") ?? "",
    windowMinutes: Number(q.get("windowMinutes") ?? 15),
    fromUnixMs: 0,
    toUnixMs: 0,
    count: total,
    p50Ms: 12,
    p95Ms: 180,
    p99Ms: 900,
    maxMs: 1200,
    buckets: Array.from({ length: 30 }, (_, i) => ({
      fromMs: i === 0 ? 0 : (BOUNDS[i - 1] as number),
      toMs: i === 29 ? null : (BOUNDS[i] as number),
      count: counts[i] ?? 0,
    })),
  };
}

test("shows the histogram with percentiles, and a bucket opens the request list in that latency range", async ({
  page,
}) => {
  // 40 fast requests in bucket 8, 5 slow ones in bucket 20.
  mock.routeHistogram = (q) => histogram({ 8: 40, 20: 5 }, q);
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url("?method=GET&route=%2Forders%2F%3Aid"));

  const panel = page.getByTestId("route-histogram");
  await expect(
    panel.getByTestId("chart-histogram").locator("canvas"),
  ).toBeVisible();
  await expect(panel).toContainText("45 requests counted before sampling");
  await expect(panel.getByTestId("histogram-p50")).toHaveText("12.0 ms");
  await expect(panel.getByTestId("histogram-p95")).toHaveText("180 ms");
  await expect(panel.getByTestId("histogram-p99")).toHaveText("900 ms");
  // Only buckets that hold requests are offered, with their counts.
  const buckets = panel.getByTestId("histogram-bucket");
  await expect(buckets).toHaveCount(2);
  await expect(buckets.nth(1)).toContainText(": 5");
  expect(await violations(page)).toEqual([]);

  // It asked for this route and method over the selected window.
  const asked = mock.requests.find((r) => r.startsWith("routes/histogram?"));
  const params = new URLSearchParams(asked?.split("?")[1]);
  expect(params.get("route")).toBe("/orders/:id");
  expect(params.get("method")).toBe("GET");
  expect(params.get("windowMinutes")).toBe("15");

  const from = BOUNDS[19] as number;
  const to = BOUNDS[20] as number;
  await buckets.nth(1).click();
  await expect(page).toHaveURL(/#\/requests\?/);
  const search = new URLSearchParams(page.url().split("#/requests?")[1]);
  expect(search.get("route")).toBe("/orders/:id");
  expect(search.get("method")).toBe("GET");
  expect(Number(search.get("minDurationMs"))).toBeCloseTo(from, 6);
  expect(Number(search.get("maxDurationMs"))).toBeCloseTo(to, 6);
  // The request list asked for exactly that range, and shows the filter.
  await expect(page.getByLabel("Minimum duration (ms)")).toHaveValue(
    String(from),
  );
  await expect(page.getByLabel("Maximum duration (ms)")).toHaveValue(
    String(to),
  );
  await expect
    .poll(() =>
      mock.requests.some(
        (r) =>
          r.startsWith("traces?") &&
          new URLSearchParams(r.split("?")[1]).get("maxDurationMs") ===
            String(to),
      ),
    )
    .toBe(true);
  expect(problems).toEqual([]);
});

test("clicking a bar of the chart does the same as its entry in the list", async ({
  page,
}) => {
  mock.routeHistogram = (q) => histogram({ 8: 40, 20: 5 }, q);
  await page.goto(url("?method=GET&route=%2Forders%2F%3Aid"));
  const chart = page.getByTestId("chart-histogram").locator(".u-over");
  await expect(chart).toBeVisible();
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (!box) throw new Error("no chart");
  // x is the bucket index on a scale of 30 bars: click the middle of bucket 8.
  await page.mouse.move(box.x + (box.width * 8.5) / 30, box.y + box.height - 4);
  await page.mouse.click(
    box.x + (box.width * 8.5) / 30,
    box.y + box.height - 4,
  );
  await expect(page).toHaveURL(/#\/requests\?/);
  const search = new URLSearchParams(page.url().split("#/requests?")[1]);
  expect(Number(search.get("minDurationMs"))).toBeCloseTo(
    BOUNDS[7] as number,
    6,
  );
  expect(Number(search.get("maxDurationMs"))).toBeCloseTo(
    BOUNDS[8] as number,
    6,
  );
});

test("a route without requests in the window says so instead of drawing an empty chart", async ({
  page,
}) => {
  mock.routeHistogram = (q) => histogram({}, q);
  await page.goto(url("?method=GET&route=%2Forders%2F%3Aid"));
  await expect(page.getByTestId("route-histogram")).toContainText(
    "No requests of this route",
  );
  await expect(page.getByTestId("chart-histogram")).toHaveCount(0);
});

const side = (count: number, errors: number, p95: number): CompareSide => ({
  count,
  errors,
  p50Ms: p95 / 2,
  p95Ms: p95,
});
function row(
  route: string,
  before: CompareSide,
  after: CompareSide,
): RouteCompareRow {
  const both = before.count > 0 && after.count > 0;
  const rate = (s: CompareSide) => (s.count ? s.errors / s.count : 0);
  return {
    method: "GET",
    route,
    before,
    after,
    delta: {
      count: after.count - before.count,
      errorRate: rate(after) - rate(before),
      p50Ms: both ? after.p50Ms - before.p50Ms : null,
      p95Ms: both ? after.p95Ms - before.p95Ms : null,
    },
  };
}

const ROWS = [
  row("/orders", side(100, 0, 100), side(120, 0, 105)), // same
  row("/orders/:id", side(80, 0, 100), side(90, 0, 400)), // slower: regression
  row("/users", side(50, 0, 200), side(40, 0, 100)), // faster
  row("/new", side(0, 0, 0), side(10, 0, 50)), // appeared
  row("/errors", side(100, 0, 20), side(100, 5, 20)), // error rate up: regression
];

function compare(q: URLSearchParams): RouteCompareResponse {
  if (q.has("releaseA")) {
    return {
      mode: "release",
      releaseA: q.get("releaseA") ?? "",
      releaseB: q.get("releaseB") ?? "",
      releases: ["1.2.0", "1.1.0", "1.0.0"],
      routes: ROWS.slice(0, 2),
    };
  }
  return {
    mode: "window",
    windowMinutes: Number(q.get("windowMinutes") ?? 15),
    previous: { fromUnixMs: 0, toUnixMs: 1 },
    current: { fromUnixMs: 1, toUnixMs: 2 },
    previousCovered: Number(q.get("windowMinutes")) !== 60,
    note:
      Number(q.get("windowMinutes")) === 60
        ? "Statistics are kept for the last 60 minutes, so no previous hour is available."
        : null,
    releases: ["1.2.0", "1.1.0", "1.0.0"],
    routes: ROWS,
  };
}

const compareRows = (page: import("@playwright/test").Page) =>
  page.getByTestId("compare-row");
const order = async (page: import("@playwright/test").Page) =>
  await compareRows(page)
    .locator("td:first-child span[title]")
    .allTextContents();

test("Compare tab: window against the previous one, regressions highlighted, sortable by change", async ({
  page,
}) => {
  mock.routeCompare = compare;
  const problems = watch(page);
  await page.goto(url());
  await page.getByRole("tab", { name: "Compare" }).click();
  await expect(page).toHaveURL(/view=compare/);
  await expect(compareRows(page)).toHaveCount(5);
  await expect(page.getByTestId("compare-note")).toContainText(
    "counted before sampling",
  );
  const asked = mock.requests.find((r) => r.startsWith("routes/compare?"));
  const params = new URLSearchParams(asked?.split("?")[1]);
  expect(params.get("windowMinutes")).toBe("15");
  expect(params.get("previous")).toBe("1");

  // Verdicts: two regressions, one improvement.
  const verdict = async (route: string) =>
    compareRows(page)
      .filter({ hasText: route })
      .first()
      .getAttribute("data-verdict");
  expect(await verdict("/orders/:id")).toBe("regression");
  expect(await verdict("/errors")).toBe("regression");
  expect(await verdict("/users")).toBe("improvement");
  expect(await verdict("/new")).toBe("same");
  await expect(page.getByTestId("compare-summary")).toContainText(
    "2 routes regressed",
  );
  // Default sort: p95 change, biggest increase first; the route with no delta is last.
  expect(await order(page)).toEqual([
    "/orders/:id",
    "/orders",
    "/errors",
    "/users",
    "/new",
  ]);
  // Clicking the p95 header flips it.
  await page.getByRole("button", { name: "p95" }).click();
  expect((await order(page))[0]).toBe("/users");
  expect((await order(page)).at(-1)).toBe("/new");
  // Sorting by name.
  await page.getByRole("button", { name: "Route", exact: true }).click();
  expect((await order(page))[0]).toBe("/errors");

  // The 60-minute window shows why there is no previous one.
  await page.getByRole("button", { name: "60 min", exact: true }).click();
  await expect(page.getByTestId("compare-note")).toContainText(
    "no previous hour is available",
  );
  expect(problems).toEqual([]);
});

test("Compare tab: release against release, from the releases seen", async ({
  page,
}) => {
  mock.routeCompare = compare;
  await page.goto(url("?view=compare"));
  await expect(compareRows(page)).toHaveCount(5);
  await page.getByRole("button", { name: "Release vs release" }).click();
  await expect(page).toHaveURL(/compare=release/);
  await expect(page.getByTestId("compare-note")).toContainText(
    "which are sampled",
  );
  // The two newest releases are chosen until a pick is made: A is the older.
  const a = page.getByLabel("Release A (before)");
  const b = page.getByLabel("Release B (after)");
  await expect(a).toHaveValue("1.1.0");
  await expect(b).toHaveValue("1.2.0");
  await expect(compareRows(page)).toHaveCount(2);
  await expect
    .poll(() =>
      mock.requests.some((r) => r.includes("releaseA=1.1.0&releaseB=1.2.0")),
    )
    .toBe(true);

  await a.selectOption("1.0.0");
  await expect(page).toHaveURL(/releaseA=1.0.0/);
  await expect
    .poll(() =>
      mock.requests.some((r) => r.includes("releaseA=1.0.0&releaseB=1.2.0")),
    )
    .toBe(true);
});
