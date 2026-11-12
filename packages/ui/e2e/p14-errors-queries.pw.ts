import type { Server } from "node:http";
import type { ErrorGroup, ErrorGroupsResponse } from "@nestrix-js/protocol";
import { expect, test } from "@playwright/test";

import { watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

// Phase 14, P14-02: the Errors and Queries pages in the shared kit.
let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash: string) => `${origin}${BASE_PATH}/#/${hash}`;
const SHOTS = "test-results";
const idOf = (seq: number) => seq.toString(16).padStart(32, "0");

/** Six groups over the window: three types, a regression-looking spike, one gone quiet. */
function richGroups(windowMinutes: number): ErrorGroupsResponse {
  const bucketMs = windowMinutes <= 15 ? 60_000 : 300_000;
  const buckets = windowMinutes <= 15 ? 15 : 12;
  const now = Date.now();
  const series = (f: (i: number) => number) =>
    Array.from({ length: buckets }, (_, i) => Math.max(0, Math.round(f(i))));
  const make = (
    n: number,
    errorType: string,
    pattern: string,
    route: string | undefined,
    s: number[],
    lastAgoBuckets: number,
  ): ErrorGroup => {
    const count = s.reduce((a, b) => a + b, 0);
    const firstIndex = s.findIndex((v) => v > 0);
    return {
      key: `g${n}`,
      errorType,
      pattern,
      ...(route === undefined ? {} : { route }),
      count,
      firstSeenUnixMs: now - (buckets - firstIndex) * bucketMs,
      lastSeenUnixMs: now - lastAgoBuckets * bucketMs - 4000,
      series: s,
      services: ["api", "billing"].slice(0, 1 + (n % 2)),
      exampleTraceId: idOf(n),
      latestMessage: pattern.replace("<n>", String(n * 17)),
      recent: Array.from({ length: Math.min(count, 4) }, (_, i) => ({
        traceId: idOf(n * 100 + i),
        spanId: idOf(n * 100 + i).slice(16),
        timeUnixMs: now - (i + 1) * 20_000,
        message: pattern.replace("<n>", String(n * 100 + i)),
        service: "api",
      })),
    };
  };
  return {
    windowMinutes,
    bucketMs,
    fromUnixMs: now - windowMinutes * 60_000,
    toUnixMs: now,
    groups: [
      make(
        1,
        "GatewayTimeoutException",
        "Payments service timed out after <n> ms",
        "POST /orders",
        series((i) => (i < buckets / 2 ? 0 : 3 + i * 1.4)),
        0,
      ),
      make(
        2,
        "NotFoundException",
        "user <n> not found",
        "GET /users/:id",
        series((i) => 2 + ((i * 7) % 5)),
        0,
      ),
      make(
        3,
        "QueryFailedError",
        "duplicate key value violates unique constraint <str>",
        "POST /users",
        series((i) => (i % 3 === 0 ? 2 : 1)),
        0,
      ),
      make(
        4,
        "ValidationError",
        "email must be an email",
        "POST /users",
        series((i) => (i > buckets - 4 ? 4 : 0)),
        0,
      ),
      make(
        5,
        "TimeoutError",
        "Redis connect timeout",
        undefined,
        series((i) => (i < 4 ? 3 : 0)),
        buckets - 4,
      ),
      make(
        6,
        "UnauthorizedException",
        "token expired",
        "GET /me",
        series((i) => (i % 4 === 0 ? 1 : 0)),
        0,
      ),
    ],
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
  test(`errors in ${scheme} mode: tiles, charts and groups (screenshot)`, async ({
    page,
  }) => {
    mock.errorGroups = richGroups;
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("errors"));
    await expect(page.getByTestId("error-group-row")).toHaveCount(6);
    await expect(page.getByTestId("page-header")).toContainText("Errors");
    await expect(
      page.getByTestId("kpi-strip").getByTestId("kpi-value"),
    ).toHaveCount(4);
    // The API gives no previous window: the change is an honest dash.
    await expect(
      page.getByTestId("kpi-events").getByTestId("delta"),
    ).toHaveAttribute("data-tone", "unknown");
    await expect(
      page.getByTestId("kpi-new").getByTestId("kpi-value"),
    ).toHaveText("2");
    await expect(
      page.getByTestId("kpi-quiet").getByTestId("kpi-value"),
    ).toHaveText("1");
    // One stacked area per type shown, and a legend row per type.
    await expect(
      page.getByTestId("errors-chart").locator("path[data-line]"),
    ).not.toHaveCount(0);
    await expect(page.getByTestId("type-row")).toHaveCount(6);
    await expect(page.getByTestId("donut-types-slice")).toHaveCount(6);
    await expect(page.getByTestId("routes-chart").locator("li")).toHaveCount(5);
    await page.screenshot({
      path: `${SHOTS}/p14-errors-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });

  test(`queries in ${scheme} mode: tiles, rankings and statements (screenshot)`, async ({
    page,
  }) => {
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("queries"));
    await expect(page.getByTestId("query-row")).toHaveCount(3);
    await expect(page.getByTestId("page-header")).toContainText("Queries");
    await expect(
      page.getByTestId("kpi-strip").getByTestId("kpi-value"),
    ).toHaveCount(4);
    await expect(
      page.getByTestId("kpi-statements").getByTestId("kpi-value"),
    ).toHaveText("3");
    await expect(
      page.getByTestId("kpi-nplus").getByTestId("kpi-value"),
    ).toHaveText("1");
    // The slowest mean is the long orders statement (120 ms).
    await expect(
      page.getByTestId("kpi-slowest-mean").getByTestId("kpi-value"),
    ).toHaveText("120");
    await expect(page.getByTestId("chart-slowest").locator("li")).toHaveCount(
      3,
    );
    await expect(
      page.getByTestId("chart-frequent").locator("li").first(),
    ).toContainText("GET session:?");
    await page.screenshot({
      path: `${SHOTS}/p14-queries-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("a group row opens on a click outside its controls; its type links to the event list", async ({
  page,
}) => {
  mock.errorGroups = richGroups;
  await page.goto(url("errors"));
  const row = page.getByTestId("error-group-row").first();
  await row.locator("td").nth(4).click();
  await expect(page.getByTestId("error-group-detail")).toHaveCount(1);
  await page
    .getByTestId("error-group-detail")
    .getByRole("link", { name: "Every event of this type" })
    .click();
  await expect(page).toHaveURL(
    /#\/errors\?view=all&type=GatewayTimeoutException$/,
  );
  await expect(page.getByTestId("type-filter")).toContainText(
    "GatewayTimeoutException",
  );
});

test("a query row opens its example trace when clicked outside its controls", async ({
  page,
}) => {
  await page.goto(url("queries"));
  await page
    .getByTestId("query-row")
    .filter({ hasText: "FROM users" })
    .locator("td")
    .nth(2)
    .click();
  await expect(page).toHaveURL(/#\/traces\/a{32}$/);
});

test("the every-event view shows its header and tiles", async ({ page }) => {
  mock.errors.push(5);
  await page.goto(url("errors?view=all"));
  await expect(
    page.getByTestId("kpi-loaded").getByTestId("kpi-value"),
  ).toHaveText("5");
  await expect(page.getByTestId("page-header")).toContainText("Errors");
});

test("phone width: no sideways page scroll on either page", async ({
  page,
}) => {
  mock.errorGroups = richGroups;
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const hash of ["errors", "queries"]) {
    await page.goto(url(hash));
    await expect(page.getByTestId("page-header")).toBeVisible();
    await expect(page.getByTestId("kpi-strip")).toBeVisible();
    const metrics = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      // Names the elements that stick out, so a failure says where.
      wide: [...document.querySelectorAll("main *")]
        .filter((el) => !el.closest("[data-slot=table-container]"))
        .filter(
          (el) => el.getBoundingClientRect().right > window.innerWidth + 1,
        )
        .slice(0, 5)
        .map((el) => `${el.tagName}.${el.className}`.slice(0, 80)),
    }));
    await page.screenshot({
      path: `${SHOTS}/p14-${hash}-phone.png`,
      fullPage: true,
    });
    // `wide` is only a hint for the failure message: clipped text also sticks out of its box.
    expect(
      metrics.page,
      `sticking out: ${metrics.wide.join(", ")}`,
    ).toBeLessThanOrEqual(metrics.viewport);
  }
});
