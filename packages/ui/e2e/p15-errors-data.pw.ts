import type { Server } from "node:http";
import type {
  ErrorGroup,
  ErrorGroupState,
  ErrorGroupsResponse,
  ErrorInsightsResponse,
} from "@nestrix-js/protocol";
import { expect, test } from "@playwright/test";

import { watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

// Phase 15, P15-02: the Errors page with the backend's group states, releases, the weekday x hour
// grid and errors per release.
let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash: string) => `${origin}${BASE_PATH}/#/${hash}`;
const SHOTS = "test-results";
const idOf = (seq: number) => seq.toString(16).padStart(32, "0");
const DAY = 86_400_000;

function groups(windowMinutes: number): ErrorGroupsResponse {
  const now = Date.now();
  const bucketMs = windowMinutes <= 15 ? 60_000 : 300_000;
  const buckets = windowMinutes <= 15 ? 15 : 12;
  const make = (
    n: number,
    type: string,
    state: ErrorGroupState,
    first: string | undefined,
    last: string | undefined,
    count: number,
  ): ErrorGroup => ({
    key: `g${n}`,
    errorType: type,
    pattern: `${type} number <n>`,
    route: `GET /r${n}`,
    count,
    firstSeenUnixMs: now - 5 * 60_000,
    lastSeenUnixMs: now - 20_000,
    series: Array.from({ length: buckets }, (_, i) =>
      i === buckets - 1 ? count : 0,
    ),
    services: ["api"],
    exampleTraceId: idOf(n),
    recent: [],
    state,
    firstEverUnixMs: now - 3 * DAY,
    lastEverUnixMs: now - 20_000,
    ...(first === undefined ? {} : { firstSeenRelease: first }),
    ...(last === undefined ? {} : { lastSeenRelease: last }),
    ...(last === undefined ? {} : { releases: [{ release: last, count }] }),
  });
  return {
    windowMinutes,
    bucketMs,
    fromUnixMs: now - windowMinutes * 60_000,
    toUnixMs: now,
    history: { fromUnixMs: now - 7 * DAY, toUnixMs: now },
    groups: [
      make(1, "BrandNewError", "new", "1.2.0", "1.2.0", 9),
      make(2, "RegressedError", "regressed", "1.0.0", "1.2.0", 7),
      make(3, "OngoingError", "ongoing", "1.1.0", "1.2.0", 5),
      make(4, "QuietError", "quiet", undefined, undefined, 2),
    ],
  };
}

function insights(withRequests: boolean): () => ErrorInsightsResponse {
  return () => {
    const now = Date.now();
    const heatmap = Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 24 }, (_, h) =>
        h >= 9 && h <= 17 && d < 5 ? 1 + ((d * h) % 4) : 0,
      ),
    );
    // The busiest cell: Wednesday 14:00 UTC.
    (heatmap[2] as number[])[14] = 12;
    const stat = (release: string, events: number, requests: number) => ({
      release,
      events,
      firstSeenUnixMs: now - 3 * DAY,
      ...(withRequests
        ? { requests, per1000Requests: (events / requests) * 1000 }
        : {}),
    });
    return {
      fromUnixMs: now - 7 * DAY,
      toUnixMs: now,
      coveredFromUnixMs: now - 7 * DAY,
      zone: "UTC",
      heatmap,
      total: heatmap.flat().reduce((a, b) => a + b, 0),
      releases: [
        stat("1.0.0", 40, 20_000),
        stat("1.1.0", 60, 12_000),
        stat("1.2.0", 30, 3_000),
      ],
    };
  };
}

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
  test(`errors data in ${scheme} mode: states, releases, heatmap (screenshot)`, async ({
    page,
  }) => {
    mock.errorGroups = groups;
    mock.errorInsights = insights(true);
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("errors"));
    const rows = page.getByTestId("error-group-row");
    await expect(rows).toHaveCount(4);
    // The state chips are the server's, in the order of the groups.
    const states = rows.locator("td:nth-child(2)");
    await expect(states).toHaveText(["New", "Regressed", "Ongoing", "Quiet"]);
    await expect(
      page.getByTestId("kpi-regressed").getByTestId("kpi-value"),
    ).toHaveText("1");
    await expect(
      page.getByTestId("kpi-new").getByTestId("kpi-value"),
    ).toHaveText("1");
    await expect(
      page.getByTestId("kpi-quiet").getByTestId("kpi-value"),
    ).toHaveText("1");
    // Releases on the rows: the newest, and the first too when it differs.
    const releases = rows.getByTestId("group-release");
    await expect(releases).toHaveText([
      "1.2.0",
      "1.0.0 → 1.2.0",
      "1.1.0 → 1.2.0",
      "-",
    ]);

    // The grid: 7 weekdays x 24 hours, with the busiest cell in the label.
    const grid = page.getByTestId("errors-heatmap");
    await expect(grid).toHaveAttribute(
      "aria-label",
      /busiest Wed 14:00 with 12/,
    );
    await expect(grid.locator("[data-level]")).toHaveCount(168);
    await expect(grid.locator("[title^='Wed 14']")).toHaveAttribute(
      "title",
      "Wed 14: 12 error events",
    );
    await expect(page.getByTestId("heatmap-note")).toContainText(
      "hours in UTC",
    );

    // Errors per release, per 1,000 requests: 2, 5 and 10.
    const bars = page.getByTestId("releases-chart").locator("li");
    await expect(bars).toHaveCount(3);
    await expect(bars.nth(0)).toContainText("1.0.0");
    await expect(bars.nth(0)).toContainText("2.0/1k");
    await expect(bars.nth(2)).toContainText("10/1k");
    await expect(page.getByTestId("card-errors-releases")).toContainText(
      "per 1,000 requests",
    );

    await page.screenshot({
      path: `${SHOTS}/p15-errors-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("without request counts the release bars are plain events, and say so", async ({
  page,
}) => {
  mock.errorGroups = groups;
  mock.errorInsights = insights(false);
  await page.goto(url("errors"));
  const bars = page.getByTestId("releases-chart").locator("li");
  await expect(bars).toHaveCount(3);
  await expect(bars.nth(1)).toContainText("60 events");
  await expect(page.getByTestId("card-errors-releases")).toContainText(
    "no request counts",
  );
});

test("a backend without insights still shows the groups", async ({ page }) => {
  mock.errorGroups = groups;
  mock.failing.add("errors/insights");
  await page.goto(url("errors"));
  await expect(page.getByTestId("error-group-row")).toHaveCount(4);
  await expect(page.getByTestId("errors-insights")).toHaveCount(0);
});

test("a store with no error events says so instead of drawing an empty grid", async ({
  page,
}) => {
  mock.errorGroups = groups;
  await page.goto(url("errors"));
  await expect(page.getByTestId("card-errors-heatmap")).toContainText(
    "No error events",
  );
  await expect(page.getByTestId("errors-heatmap")).toHaveCount(0);
  await expect(page.getByTestId("card-errors-releases")).toContainText(
    "service.version",
  );
});

test("phone width: no sideways page scroll with the new cards", async ({
  page,
}) => {
  mock.errorGroups = groups;
  mock.errorInsights = insights(true);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("errors"));
  await expect(page.getByTestId("errors-heatmap")).toBeVisible();
  const metrics = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
});
