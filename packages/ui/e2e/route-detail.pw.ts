// P12-02: the route detail page (`#/route?method=&route=`): the "What changed" card, KPIs, the
// per-side time bars, the tables, the empty states and the way in from the Overview, the Routes
// page and a trace. Mocked API.
import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { degraded, routeAnswers } from "./mock-overview.ts";
import {
  emptyExplain,
  fewTraces,
  ORDERS_STATEMENT,
  releases,
  slower,
} from "./mock-route-explain.ts";
import { histogramFor } from "./mock-route-histogram.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash: string) => `${origin}${BASE_PATH}/#/${hash}`;
const ORDERS = "route?method=POST&route=%2Forders";
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
  mock.routeHistogram = histogramFor;
  mock.routeExplain = (q) => (q.has("releaseA") ? releases(q) : slower(q));
});

const text = (page: Page, testId: string) =>
  page.getByTestId(testId).textContent();

test("a slower route: summary, ranked findings, KPIs and every card", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url(ORDERS));

  await expect(page.getByTestId("route-title")).toHaveText("POST/orders");
  await expect(page.getByTestId("breadcrumb")).toHaveText(
    "Overview/Routes/POST /orders",
  );
  // The Routes tab stays marked while the route page is open.
  await expect(
    page.getByRole("navigation", { name: "Sections" }).getByRole("link", {
      name: "Routes",
    }),
  ).toHaveClass(/border-primary/);

  // What changed: the summary, then the findings in the order the API ranked them.
  const card = page.getByTestId("card-what-changed");
  await expect(card.getByTestId("source")).toHaveText(
    "from up to 2,000 sampled traces per side",
  );
  await expect(page.getByTestId("summary")).toContainText(
    "Mean time went from 214 ms to 436 ms",
  );
  const findings = page.getByTestId("finding");
  await expect(findings).toHaveCount(3);
  await expect(findings.nth(0)).toHaveAttribute("data-kind", "n-plus-one");
  await expect(findings.nth(0)).toHaveAttribute("data-direction", "worse");
  await expect(findings.nth(0).getByTestId("finding-title")).toContainText(
    `runs 6.4 times per request (${ORDERS_STATEMENT})`,
  );
  // Direction is a word and an arrow, not colour alone.
  await expect(findings.nth(0).getByTestId("finding-direction")).toHaveText(
    "Worse",
  );
  await expect(findings.nth(2).getByTestId("finding-direction")).toHaveText(
    "Better",
  );
  await expect(findings.nth(0).getByTestId("finding-share")).toHaveText(
    "96% of the change",
  );
  // The bar is as wide as the share.
  const width = await findings
    .nth(0)
    .getByTestId("finding-share-bar")
    .evaluate((el) => (el as HTMLElement).style.width);
  expect(width).toBe("96%");
  // A finding without a share has no bar.
  await expect(findings.nth(1).getByTestId("finding-share-bar")).toHaveCount(0);
  await expect(findings.nth(0).getByTestId("finding-link")).toHaveAttribute(
    "href",
    /#\/queries\?windowMinutes=15&q=SELECT\+\*\+FROM\+order_items.*&nplus=true$/,
  );
  await expect(findings.nth(1).getByTestId("finding-link")).toHaveAttribute(
    "href",
    /#\/errors\?view=all&route=%2Forders&type=PaymentGatewayError$/,
  );

  // KPI tiles, each with its change; statistics are before sampling, queries from traces.
  const kpi = (id: string) => page.locator(`[data-kpi="${id}"]`);
  await expect(page.getByTestId("kpi")).toHaveCount(5);
  await expect(kpi("p95").getByTestId("kpi-value")).toHaveText("680 ms");
  await expect(kpi("p95").getByTestId("delta")).toHaveText("+65%");
  await expect(kpi("p95").getByTestId("delta")).toHaveAttribute(
    "data-tone",
    "worse",
  );
  await expect(kpi("p95")).toContainText("was 412 ms");
  await expect(kpi("p95")).toHaveAttribute("data-source", "stats");
  await expect(kpi("queries").getByTestId("kpi-value")).toHaveText("9.4");
  await expect(kpi("queries").getByTestId("delta")).toHaveText("+6.4");
  await expect(kpi("queries")).toHaveAttribute("data-source", "traces");
  await expect(page.getByTestId("kpi-source")).toContainText(
    "route statistics, counted before sampling",
  );
  await expect(page.getByTestId("error-chip")).toBeVisible();

  // The latency histogram is the Routes page's, with its own source line.
  await expect(
    page.getByTestId("card-histogram").getByTestId("source"),
  ).toContainText("counted before sampling");
  await expect(
    page.getByTestId("card-histogram").getByTestId("histogram-p95"),
  ).toHaveText("680 ms");
  const histogramAsk = new URLSearchParams(
    mock.requests.find((r) => r.startsWith("routes/histogram?"))?.split("?")[1],
  );
  expect(histogramAsk.get("route")).toBe("/orders");
  expect(histogramAsk.get("method")).toBe("POST");
  expect(histogramAsk.get("windowMinutes")).toBe("15");

  // Time by kind, per side: two bars, a legend with the numbers as text.
  const bars = page.getByTestId("kind-bar");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0)).toContainText("Previous 15 min");
  await expect(bars.nth(0)).toContainText("214 ms");
  await expect(bars.nth(1)).toContainText("Last 15 min");
  await expect(bars.nth(1)).toContainText("436 ms");
  await expect(bars.nth(1).getByRole("img")).toHaveAttribute(
    "aria-label",
    /Database 318 ms/,
  );
  const dbWidth = await bars
    .nth(1)
    .locator('[data-kind="db"]')
    .evaluate((el) => (el as HTMLElement).style.width);
  expect(Number.parseFloat(dbWidth)).toBeCloseTo((318 / 436) * 100, 1);
  await expect(
    page.getByTestId("kind-legend").locator('[data-kind="db"]'),
  ).toContainText("96.0 ms → 318 ms");

  // Statements: the new one first, its calls and time before and after.
  const statements = page.getByTestId("statement-row");
  await expect(statements).toHaveCount(4);
  await expect(statements.nth(0)).toContainText(ORDERS_STATEMENT);
  await expect(statements.nth(0)).toContainText("0 → 6.4");
  await expect(statements.nth(0)).toContainText("+6.4");
  await expect(statements.nth(0)).toContainText("0.00 ms → 214 ms");
  await expect(
    page.getByTestId("card-statements").getByTestId("source"),
  ).toContainText("from sampled traces");
  await expect(page.getByTestId("method-row")).toHaveCount(2);
  await expect(page.getByTestId("method-row").first()).toContainText(
    "OrderItemsRepository.findByOrder",
  );
  const deps = page.getByTestId("dependency-row");
  await expect(deps).toHaveCount(2);
  await expect(deps.first()).toContainText("api.stripe.com");
  await expect(deps.first()).toContainText("+6.0 pt");
  await expect(page.getByTestId("error-row").first()).toContainText(
    "PaymentGatewayError",
  );
  await expect(page.getByTestId("error-row").first()).toContainText("0 → 14");

  // Slowest traces link to the trace page.
  const slow = page.getByTestId("slow-trace");
  await expect(slow).toHaveCount(3);
  await expect(slow.first()).toContainText("4.80 s");
  await expect(slow.first().locator("a")).toHaveAttribute(
    "href",
    /#\/traces\/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1$/,
  );

  // Every card says where its figures come from.
  for (const id of [
    "card-what-changed",
    "card-histogram",
    "card-kinds",
    "card-statements",
    "card-methods",
    "card-dependencies",
    "card-errors",
    "card-slowest",
  ])
    await expect(page.getByTestId(id).getByTestId("source")).not.toBeEmpty();

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("the picker changes the window and sends it to the API", async ({
  page,
}) => {
  await page.goto(url(ORDERS));
  await expect(page.getByTestId("summary")).toBeVisible();
  await page.getByTestId("compare-picker").selectOption("window-60");
  await expect(page).toHaveURL(/windowMinutes=60/);
  await expect(page.getByTestId("kind-bar").first()).toContainText(
    "Previous 60 min",
  );
  const asked = mock.requests
    .filter((r) => r.startsWith("routes/explain"))
    .map((r) => new URLSearchParams(r.split("?")[1]));
  expect(asked.at(-1)?.get("windowMinutes")).toBe("60");
  expect(asked.at(-1)?.get("route")).toBe("/orders");
  expect(asked.at(-1)?.get("method")).toBe("POST");
  expect(asked.at(-1)?.has("releaseA")).toBe(false);
});

test("release against release: the newest two, named sides, sampled KPIs, a picker", async ({
  page,
}) => {
  await page.goto(url(ORDERS));
  await expect(page.getByTestId("summary")).toBeVisible();
  await page.getByTestId("compare-picker").selectOption("release");
  await expect(page).toHaveURL(/compare=release/);
  // Starts from the two newest releases.
  await expect(page.getByTestId("before-release")).toHaveValue("v1.8.1");
  await expect(page.getByTestId("after-release")).toHaveValue("v1.8.2");
  await expect(page.getByTestId("kind-bar").nth(0)).toContainText("v1.8.1");
  await expect(page.getByTestId("kind-bar").nth(1)).toContainText("v1.8.2");
  await expect(page.getByTestId("kpi-source")).toHaveText(
    "Every figure is from sampled traces of the two releases.",
  );
  await expect(page.locator('[data-kpi="p95"]')).toHaveAttribute(
    "data-source",
    "traces",
  );
  await expect(
    page.getByTestId("card-histogram").getByTestId("source"),
  ).toContainText("the window, not the releases");

  await page.getByTestId("before-release").selectOption("v1.8.0");
  await expect(page).toHaveURL(/releaseA=v1.8.0/);
  await expect(page.getByTestId("kind-bar").nth(0)).toContainText("v1.8.0");
  const last = mock.requests
    .filter((r) => r.startsWith("routes/explain"))
    .at(-1);
  const q = new URLSearchParams(last?.split("?")[1]);
  expect(q.get("releaseA")).toBe("v1.8.0");
  expect(q.get("releaseB")).toBe("v1.8.2");
  expect(q.has("windowMinutes")).toBe(false);
});

test("a release link opens in release mode from the URL", async ({ page }) => {
  await page.goto(
    url(`${ORDERS}&compare=release&releaseA=v1.8.0&releaseB=v1.8.1`),
  );
  await expect(page.getByTestId("kind-bar").nth(0)).toContainText("v1.8.0");
  await expect(page.getByTestId("kind-bar").nth(1)).toContainText("v1.8.1");
});

test("too few traces: the summary sentence and the tables, no findings", async ({
  page,
}) => {
  mock.routeExplain = (q) => fewTraces(q);
  await page.goto(url(ORDERS));
  await expect(page.getByTestId("summary")).toHaveText(
    "Not enough traces to compare (3 before, 140 after).",
  );
  await expect(page.getByTestId("too-few")).toBeVisible();
  await expect(page.getByTestId("finding")).toHaveCount(0);
  await expect(page.getByTestId("statement-row")).toHaveCount(4);
  await expect(page.getByTestId("kind-bar")).toHaveCount(2);
});

test("an unknown route: a friendly message, not empty cards", async ({
  page,
}) => {
  mock.routeExplain = (q) => emptyExplain(q);
  await page.goto(url("route?method=GET&route=%2Fnope"));
  await expect(page.getByTestId("no-traces")).toContainText(
    "No traces for this route.",
  );
  await expect(page.getByTestId("no-traces")).toContainText("GET /nope");
  await expect(page.getByTestId("card-what-changed")).toHaveCount(0);
  await expect(page.getByTestId("kpi")).toHaveCount(0);
  await expect(page.getByTestId("no-traces").getByRole("link")).toHaveAttribute(
    "href",
    /#\/routes$/,
  );
});

test("without a route in the URL it points to the Routes page", async ({
  page,
}) => {
  await page.goto(url("route"));
  await expect(page.getByTestId("no-route")).toBeVisible();
  expect(mock.requests.some((r) => r.startsWith("routes/explain"))).toBe(false);
});

test("an API failure shows an error and a retry", async ({ page }) => {
  mock.failing.add("routes/explain");
  await page.goto(url(ORDERS));
  await expect(page.getByTestId("route-error")).toContainText("Mock failure");
  mock.failing.delete("routes/explain");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("summary")).toBeVisible();
});

test("from the Overview: the top-issue button, an insight and a route row all lead here", async ({
  page,
}) => {
  mock.overview = (w) => degraded(w);
  await page.goto(url(""));
  await page.getByTestId("investigate").click();
  await expect(page).toHaveURL(/#\/route\?method=POST&route=%2Forders$/);
  await expect(page.getByTestId("summary")).toBeVisible();

  await page.goBack();
  await page
    .getByTestId("card-attention")
    .getByTestId("insight")
    .first()
    .click();
  await expect(page).toHaveURL(/#\/route\?method=POST&route=%2Forders$/);

  await page.goBack();
  await page
    .getByTestId("overview-route")
    .filter({ hasText: "/search" })
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(/#\/route\?method=GET&route=%2Fsearch$/);
  await expect(page.getByTestId("route-title")).toHaveText("GET/search");
  // The breadcrumb goes back.
  await page
    .getByTestId("breadcrumb")
    .getByRole("link", { name: "Overview" })
    .click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("from the Routes page: a Details link per row, next to the histogram panel", async ({
  page,
}) => {
  await page.goto(url("routes"));
  const row = page
    .getByTestId("route-row")
    .filter({ hasText: "/orders" })
    .first();
  await expect(row.getByTestId("route-details-link")).toHaveText("Details");
  await row.getByTestId("route-details-link").click();
  await expect(page).toHaveURL(/#\/route\?method=POST&route=%2Forders$/);
  await expect(page.getByTestId("summary")).toBeVisible();
  // Picking the route on the Routes page still opens the panel there.
  await page.goBack();
  await row.getByRole("button", { name: "/orders" }).click();
  await expect(page.getByTestId("route-detail")).toBeVisible();
});

test("from a trace: a link to the route of its root", async ({ page }) => {
  mock.reset(5);
  await page.goto(url("requests"));
  const first = page.getByTestId("requests").locator("tbody tr a").first();
  await first.click();
  await expect(page.getByTestId("trace-title")).toBeVisible();
  const title = (await text(page, "trace-title")) ?? "";
  const [method, route] = title.split(" ");
  await page.getByTestId("trace-route-link").click();
  await expect(page).toHaveURL(
    new RegExp(
      `#/route\\?method=${method}&route=${encodeURIComponent(route ?? "")}$`,
    ),
  );
});

test("a slowest trace opens the trace page", async ({ page }) => {
  await page.goto(url(ORDERS));
  await page.getByTestId("slow-trace").first().locator("a").click();
  await expect(page).toHaveURL(/#\/traces\/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1$/);
});

// The page's own content stays inside a phone screen; wide tables scroll inside their card. (The
// shell's section tabs are wider than a phone on every page: not this page's concern.)
test("phone width: the page content does not overflow sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(url(ORDERS));
  await expect(page.getByTestId("summary")).toBeVisible();
  const outside = await page.evaluate(() => {
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement)
        if (getComputedStyle(p).overflowX !== "visible") return true;
      return false;
    };
    return [...document.querySelectorAll("main *")]
      .filter(
        (el) =>
          el.getBoundingClientRect().right > innerWidth + 1 && !clipped(el),
      )
      .map((el) => `${el.tagName}.${el.className}`);
  });
  expect(outside).toEqual([]);
});

for (const scheme of ["dark", "light"] as const) {
  test(`route detail in ${scheme} mode reads well (screenshot)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url(ORDERS));
    await expect(page.getByTestId("finding")).toHaveCount(3);
    await expect(page.getByTestId("slow-trace")).toHaveCount(3);
    const background = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(background).toBe(
      scheme === "dark" ? "oklch(0.145 0 0)" : "oklch(1 0 0)",
    );
    await page.screenshot({
      path: `${SHOTS}/route-detail-${scheme}.png`,
      fullPage: true,
    });
  });
}
