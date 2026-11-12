import type { Server } from "node:http";
import type { Slo } from "@nestrix-js/protocol";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, requestRows, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import {
  degraded,
  empty,
  healthy,
  routeAnswers,
  UNCOVERED_NOTE,
  uncovered,
} from "./mock-overview.ts";
import { BASE_PATH, startServer } from "./serve.ts";

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
  mock.reset(0);
  const routes = routeAnswers();
  mock.routeStats = routes.stats;
  mock.routeCompare = (q) =>
    routes.compare(Number(q.get("windowMinutes") ?? 15));
});

const text = (page: Page, testId: string) =>
  page.getByTestId(testId).textContent();

test("degraded: the verdict, both lists, the KPI changes and the donuts", async ({
  page,
}) => {
  mock.overview = (w) => degraded(w);
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());

  // The home page is the Overview.
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const health = page.getByTestId("health");
  await expect(health).toHaveAttribute("data-level", "degraded");
  await expect(page.getByTestId("health-score")).toHaveText("74");
  await expect(page.getByTestId("health-level")).toHaveText("Degraded");
  await expect(page.getByTestId("health-summary")).toContainText(
    "2 things need attention: POST /orders p95 412 ms → 680 ms",
  );

  // Needs attention: three rows, severity as words, each row names its source.
  const attention = page.getByTestId("card-attention");
  await expect(attention.getByTestId("count")).toHaveText("3");
  const rows = attention.getByTestId("insight");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("POST /orders p95 412 ms → 680 ms");
  await expect(rows.nth(0).getByTestId("severity")).toHaveText("High");
  await expect(rows.nth(0).getByTestId("insight-change")).toHaveText("+65%");
  await expect(rows.nth(0)).toContainText("before sampling");
  await expect(rows.nth(1).getByTestId("insight-change")).toHaveText("new");
  await expect(rows.nth(1)).toContainText("from sampled traces");
  await expect(rows.nth(2).getByTestId("severity")).toHaveText("Medium");
  await expect(rows.nth(0).getByTestId("trend")).toBeVisible();

  // Getting better.
  const better = page.getByTestId("card-better");
  await expect(better.getByTestId("count")).toHaveText("1");
  await expect(better.getByTestId("insight")).toContainText(
    "GET /products/:id p95 133 ms → 96 ms",
  );
  await expect(better.getByTestId("insight-change")).toHaveText("−28%");

  // KPI tiles with their change against the previous window.
  const delta = (id: string) =>
    page.getByTestId(`kpi-${id}`).getByTestId("delta");
  await expect(page.getByTestId("kpi-throughput")).toContainText("1,284");
  await expect(delta("throughput")).toHaveText("+7%");
  await expect(page.getByTestId("kpi-errors")).toContainText("1.9");
  await expect(delta("errors")).toHaveText("+1.2 pt");
  await expect(delta("errors")).toHaveAttribute("data-tone", "worse");
  await expect(page.getByTestId("kpi-p95")).toContainText("412");
  await expect(delta("p95")).toHaveText("+18%");
  await expect(page.getByTestId("kpi-apdex")).toContainText("0.91");
  await expect(delta("apdex")).toHaveText("−0.03");
  await expect(page.getByTestId("kpi-dependency")).toBeVisible();
  await expect(
    page.getByTestId("kpi-dependency").getByTestId("kpi-value"),
  ).not.toHaveText("—");

  // Charts: percentile lines (previous p95 grey), a release marker, bars and donuts.
  const latency = page.getByTestId("latency-chart");
  for (const line of ["p50", "p95", "p99", "prev"])
    await expect(latency.locator(`[data-line=${line}]`)).toHaveCount(1);
  await expect(page.getByTestId("release-marker")).toHaveCount(1);
  await expect(page.getByTestId("release-label")).toContainText("v1.8.2");
  await expect(page.getByTestId("throughput-bar")).toHaveCount(15);

  await expect(page.getByTestId("donut-status-slice")).toHaveCount(4);
  await expect(
    page.locator("[data-testid=donut-status-slice][data-slice=ok]"),
  ).toHaveAttribute("data-fraction", "0.9400");
  await expect(page.getByTestId("donut-status")).toContainText("94.0%");
  // A kind without time (messaging) has no slice; the others show their share change.
  await expect(page.getByTestId("donut-time-slice")).toHaveCount(5);
  const db = page.locator("[data-testid=time-row][data-key=db]");
  await expect(db).toContainText("41.0%");
  await expect(db.getByTestId("delta")).toHaveText("+12.0 pt");
  await expect(db.getByTestId("delta")).toHaveAttribute("data-tone", "worse");

  // Apdex bar: 16,564 / 1,926 / 770 of 19,260.
  await expect(page.getByTestId("apdex-satisfied")).toContainText("86.0%");
  await expect(page.getByTestId("apdex-tolerating")).toContainText("10.0%");
  await expect(page.getByTestId("apdex-frustrated")).toContainText("4.0%");
  await expect(page.getByTestId("card-apdex")).toContainText("Target 300 ms");

  // Top routes, ranked by count times p95 change.
  const names = await page
    .getByTestId("overview-route")
    .evaluateAll((trs) =>
      trs.map((tr) => tr.querySelector("td")?.textContent?.trim()),
    );
  expect(names).toEqual(["POST/orders", "GET/products/:id", "GET/search"]);
  await expect(
    page.getByTestId("overview-route").first().getByTestId("delta"),
  ).toHaveText("+65%");

  // Every card names its source.
  for (const id of [
    "card-latency",
    "card-status",
    "card-time",
    "card-throughput",
    "card-apdex",
    "card-routes",
    "card-attention",
    "card-better",
  ]) {
    expect(await text(page, id), id).toMatch(
      /before sampling|from sampled traces/,
    );
  }
  await expect(page.getByTestId("card-status")).toContainText(
    "from sampled traces",
  );
  await expect(page.getByTestId("card-latency")).toContainText(
    "before sampling",
  );

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);

  // The button leads to the top attention item.
  await page.getByTestId("investigate").click();
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toMatch(/^#\/route\?/);
  expect(await page.evaluate(() => location.hash)).toContain("route=%2Forders");
});

for (const scheme of ["dark", "light"] as const) {
  test(`degraded in ${scheme} mode reads well (screenshot)`, async ({
    page,
  }) => {
    mock.overview = (w) => degraded(w);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url());
    await expect(page.getByTestId("health")).toBeVisible();
    await expect(page.getByTestId("overview-route")).toHaveCount(3);
    const background = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    // Dark and light really differ; the tokens switch with the scheme.
    expect(background).toBe(
      scheme === "dark" ? "oklch(0.145 0 0)" : "oklch(1 0 0)",
    );
    await page.screenshot({
      path: `${SHOTS}/overview-${scheme}.png`,
      fullPage: true,
    });
  });
}

test("healthy: nothing needs attention, two things got better", async ({
  page,
}) => {
  mock.overview = (w) => healthy(w);
  await page.goto(url());
  await expect(page.getByTestId("health")).toHaveAttribute(
    "data-level",
    "healthy",
  );
  await expect(page.getByTestId("health-score")).toHaveText("97");
  await expect(page.getByTestId("health-summary")).toHaveText(
    "No problems found. 2 things got better.",
  );
  await expect(page.getByTestId("investigate")).toHaveCount(0);
  const attention = page.getByTestId("card-attention");
  await expect(attention.getByTestId("insight")).toHaveCount(0);
  await expect(attention.getByTestId("empty")).toHaveText(
    "Nothing needs attention.",
  );
  await expect(
    page.getByTestId("card-better").getByTestId("insight"),
  ).toHaveCount(2);
  await expect(
    page.getByTestId("kpi-errors").getByTestId("delta"),
  ).toHaveAttribute("data-tone", "better");
});

test("no traffic: a friendly empty state, no cards", async ({ page }) => {
  // The default answer of the mock has no requests.
  await page.goto(url());
  await expect(page.getByTestId("overview-empty")).toContainText(
    "No requests in the last 15 minutes",
  );
  await expect(page.getByTestId("health")).toHaveCount(0);
  await expect(page.getByTestId("card-attention")).toHaveCount(0);

  mock.overview = (w) => empty(w);
  await page.getByRole("button", { name: "60 min", exact: true }).click();
  await expect(page.getByTestId("overview-empty")).toContainText(
    "No requests in the last 60 minutes",
  );
});

test("previous window not kept: changes are dashes with the note, lists say why", async ({
  page,
}) => {
  mock.overview = (w) => uncovered(w);
  await page.goto(url());
  await expect(page.getByTestId("uncovered-note")).toContainText(
    "Comparisons start once a full previous window is kept.",
  );
  for (const id of ["throughput", "errors", "p95", "apdex"]) {
    const delta = page.getByTestId(`kpi-${id}`).getByTestId("delta");
    await expect(delta).toHaveText("—");
    await expect(delta).toHaveAttribute("title", UNCOVERED_NOTE);
  }
  // A new error group needs no "before", so it is still listed.
  const attention = page.getByTestId("card-attention");
  await expect(attention.getByTestId("insight")).toHaveCount(1);
  await expect(attention.getByTestId("insight")).toContainText(
    "PaymentGatewayError is new",
  );
  await expect(
    page.getByTestId("card-better").getByTestId("empty"),
  ).toContainText("Comparisons start once a full previous window is kept.");
  // No previous series: the grey line is not drawn.
  await expect(
    page.getByTestId("latency-chart").locator("[data-line=prev]"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("overview-route").first().getByTestId("delta"),
  ).toBeVisible();
});

test("the window toggle asks for 60 minutes and keeps it in the URL", async ({
  page,
}) => {
  mock.overview = (w) => degraded(w);
  await page.goto(url());
  const toggle = (minutes: number) =>
    page.getByRole("button", { name: `${minutes} min`, exact: true });
  await expect(toggle(15)).toHaveAttribute("aria-pressed", "true");
  await toggle(60).click();
  await expect(toggle(60)).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/windowMinutes=60/);
  await expect
    .poll(() =>
      mock.requests.some(
        (r) => r.startsWith("overview?") && r.includes("windowMinutes=60"),
      ),
    )
    .toBe(true);
  await expect(page.getByTestId("throughput-bar")).toHaveCount(12);
  await expect(page.getByTestId("health-summary")).toBeVisible();
  // It is still the Overview, not a redirect to the request list.
  expect(await page.evaluate(() => location.hash)).toMatch(
    /^#\/\?windowMinutes=60/,
  );
});

test("an old deep link to the request list is redirected to /requests with its params", async ({
  page,
}) => {
  mock.push(60);
  const problems = watch(page);
  await page.goto(url("?status=error&minDurationMs=100"));
  await expect(requestRows(page).first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe("#/requests?status=error&minDurationMs=100");
  await expect(page.getByLabel("Minimum duration (ms)")).toHaveValue("100");
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
  // The back button does not return to the redirecting address.
  await page.goBack();
  expect(await page.evaluate(() => location.hash)).not.toBe(
    "#/?status=error&minDurationMs=100",
  );

  // Other request-list params, and a link made while the page is already open, are redirected too.
  await page.goto(url("?search=users"));
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe("#/requests?search=users");
  await page.evaluate(() => {
    location.hash = "#/?route=%2Forders&method=GET";
  });
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe("#/requests?route=%2Forders&method=GET");

  // The home page with only its own params stays the Overview.
  await page.goto(url("?windowMinutes=60"));
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("#/?windowMinutes=60");
  expect(problems.filter((p) => !p.includes("HTTP"))).toEqual([]);
});

test("navigation: Overview is first and active at home, Requests is its own page", async ({
  page,
}) => {
  mock.push(5);
  mock.overview = (w) => degraded(w);
  await page.goto(url());
  const links = page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link");
  await expect(links.nth(0)).toHaveText("Overview");
  await expect(links.nth(1)).toHaveText("Requests");
  await expect(links.nth(0)).toHaveAttribute("aria-current", "page");
  await links.nth(1).click();
  await expect(requestRows(page).first()).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("#/requests");
  await expect(links.nth(1)).toHaveAttribute("aria-current", "page");
  await expect(links.nth(0)).not.toHaveAttribute("aria-current", "page");
  await links.nth(0).click();
  await expect(page.getByTestId("health")).toBeVisible();
});

test("embedded: the runtime card shows when the runtime is available", async ({
  page,
}) => {
  mock.overview = (w) => degraded(w);
  mock.runtimeSamples = [
    {
      timeUnixMs: Date.now(),
      eventLoopP50Ms: 1,
      eventLoopP99Ms: 38,
      eventLoopMaxMs: 60,
      heapUsedBytes: 40_000_000,
      heapTotalBytes: 60_000_000,
      rssBytes: 120_000_000,
      externalBytes: 1_000_000,
      cpuUserPercent: 60,
      cpuSystemPercent: 21,
      activeResources: 4,
    },
  ];
  await page.goto(url());
  const card = page.getByTestId("card-runtime");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("runtime-cpu")).toContainText("81");
  await expect(card.getByTestId("runtime-loop")).toContainText("38");
  await expect(page.getByTestId("card-slos")).toHaveCount(0);

  mock.runtimeAvailable = false;
  await page.reload();
  await expect(page.getByTestId("health")).toBeVisible();
  await expect(page.getByTestId("card-runtime")).toHaveCount(0);
});

test("standalone: the service is sent and the SLO budget rings show", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.services = ["billing", "orders"];
  mock.overview = (w) => degraded(w);
  const slo = (id: string, name: string, remaining: number): Slo => ({
    id,
    name,
    service: "orders",
    route: null,
    kind: "availability",
    latencyThresholdMs: null,
    objective: 0.999,
    windowDays: 30,
    createdAtUnixMs: 0,
    updatedAtUnixMs: 0,
    status: {
      totalRequests: 1000,
      goodRequests: 999,
      badRequests: 1,
      attainment: 0.999,
      errorBudget: {
        totalRequests: 1,
        remainingRequests: remaining,
        remainingFraction: remaining,
      },
      burnRate: { "1h": 0.5, "6h": 0.5 },
      breached: remaining < 0,
    },
  });
  mock.slos = [
    slo("1", "Checkout availability", 0.94),
    slo("2", "Search latency", 0.1),
    slo("3", "Login availability", -0.4),
  ];
  await page.goto(url("?service=orders"));
  await expect(page.getByTestId("health")).toBeVisible();
  await expect
    .poll(() =>
      mock.requests.some(
        (r) => r.startsWith("overview?") && r.includes("service=orders"),
      ),
    )
    .toBe(true);
  const rings = page.getByTestId("slo-ring");
  await expect(rings).toHaveCount(3);
  await expect(rings.nth(0)).toHaveAttribute("data-state", "ok");
  await expect(rings.nth(1)).toHaveAttribute("data-state", "low");
  await expect(rings.nth(2)).toHaveAttribute("data-state", "spent");
  await expect(rings.nth(2)).toContainText("budget spent");
  await expect(page.getByTestId("card-runtime")).toHaveCount(0);
});
