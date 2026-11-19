// Issue #18: the standalone Metrics page. Hidden unless `meta.metrics.available`; one chart per
// catalog metric with its unit, gaps and empty states; the instance, aggregation and window
// controls reach the API; a click or drag on a chart opens the requests of that time in the same
// service and environment; a trace links to the metrics around it. Mocked API.
import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash: string) => `${origin}${BASE_PATH}/#/${hash}`;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset(0);
  mock.mode = "standalone";
  mock.services = ["orders", "billing"];
  mock.metricsAvailable = true;
});

const panel = (page: Page, name: string) =>
  page.getByTestId(`metric-panel-${name}`);
const chart = (page: Page, name: string) =>
  page.getByTestId(`metric-chart-${name}`);

/** The `metrics/series` requests the mock saw, as parsed query strings. */
const seriesRequests = (name?: string) =>
  mock.requests
    .filter((r) => r.startsWith("metrics/series"))
    .map((r) => new URLSearchParams(r.split("?")[1] ?? ""))
    .filter((q) => name === undefined || q.get("metric") === name);
const lastSeries = (name: string) => seriesRequests(name).at(-1);

test("the page and its menu entry exist only when the server stores metrics", async ({
  page,
}) => {
  mock.metricsAvailable = false;
  await page.goto(url(""));
  await expect(page.getByTestId("mode")).toBeVisible();
  await expect(
    page.getByTestId("section-menu").getByRole("link", { name: "Metrics" }),
  ).toHaveCount(0);
  await page.goto(url("metrics"));
  await expect(page.getByTestId("metrics-off")).toContainText(
    "NESTRIX_METRICS=on",
  );
  expect(seriesRequests()).toHaveLength(0);

  mock.metricsAvailable = true;
  await page.goto(url(""));
  await page
    .getByTestId("section-menu")
    .getByRole("link", { name: "Metrics" })
    .click();
  await expect(page).toHaveURL(/#\/metrics/);
  await expect(page.getByTestId("metrics-off")).toHaveCount(0);
  await expect(chart(page, "process.cpu.time")).toBeVisible();
});

test("an embedded dashboard has no Metrics entry", async ({ page }) => {
  mock.mode = "embedded";
  mock.metricsAvailable = true;
  await page.goto(url(""));
  await expect(page.getByTestId("section-menu")).toBeVisible();
  await expect(
    page.getByTestId("section-menu").getByRole("link", { name: "Metrics" }),
  ).toHaveCount(0);
});

test("draws a chart per catalog metric with its unit, shows gaps, and an empty state where there is no data", async ({
  page,
}) => {
  await recordViolations(page);
  await page.goto(url("metrics"));
  for (const name of [
    "process.cpu.time",
    "process.memory.usage",
    "v8js.memory.heap.used",
    "nodejs.eventloop.delay.p99",
  ]) {
    await expect(chart(page, name).locator("canvas").first()).toBeVisible();
  }
  // The catalog decides which panels exist, in a fixed order.
  await expect(page.locator("[data-testid^=metric-panel-]")).toHaveCount(6);

  // Units are read from the catalog.
  await expect(
    panel(page, "process.cpu.time").getByTestId("metric-meaning"),
  ).toContainText("share of one core");
  await expect(
    panel(page, "process.cpu.time").getByTestId("metric-meaning"),
  ).toContainText("sum of instances");
  await expect(
    panel(page, "process.memory.usage").getByTestId("metric-meaning"),
  ).toContainText("bytes");
  await expect(
    panel(page, "process.memory.usage").getByTestId("metric-meaning"),
  ).toContainText("average of instances");
  await expect(
    panel(page, "nodejs.eventloop.delay.p99").getByTestId("metric-meaning"),
  ).toContainText("seconds");

  // A null in the answer is a gap in the data the chart is given, and is said in words.
  await expect(
    panel(page, "process.memory.usage").getByTestId("metric-gaps"),
  ).toHaveText("3 points without data");
  await expect(
    panel(page, "process.cpu.time").getByTestId("metric-gaps"),
  ).toHaveCount(0);

  // No data at all for one metric: an empty state instead of a flat line.
  await expect(
    panel(page, "nodejs.eventloop.delay.max").getByTestId("metric-empty"),
  ).toBeVisible();
  await expect(chart(page, "nodejs.eventloop.delay.max")).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test("a histogram panel sends no aggregation and no split, and says what it computes", async ({
  page,
}) => {
  await page.goto(url("metrics"));
  const duration = "http.server.request.duration";
  await expect(chart(page, duration)).toBeVisible();
  await page.getByTestId("metrics-aggregation").selectOption("max");
  await page.getByTestId("metrics-split").check();
  await expect
    .poll(() => lastSeries("process.memory.usage")?.get("by"))
    .toBe("instance");
  expect(seriesRequests(duration).length).toBeGreaterThan(0);
  for (const q of seriesRequests(duration)) {
    expect(q.has("aggregation")).toBe(false);
    expect(q.has("by")).toBe(false);
  }
  await expect(
    panel(page, duration).getByTestId("metric-meaning"),
  ).toContainText("percentiles are computed over all instances");
  // The other panels did receive both.
  expect(lastSeries("process.memory.usage")?.get("aggregation")).toBe("max");
});

test("choosing an instance with all services selected sends its service too", async ({
  page,
}) => {
  mock.metrics.otherService = "billing";
  await page.goto(url("metrics"));
  const select = page.getByTestId("metrics-instance");
  await expect(select.locator("option")).toHaveText([
    "All instances",
    "orders / pod-a",
    "orders / pod-b",
    "billing / pod-a",
    "billing / pod-b",
  ]);
  await select.selectOption({ label: "billing / pod-a" });
  await expect
    .poll(() => {
      const q = lastSeries("process.memory.usage");
      return `${q?.get("service")}/${q?.get("instance")}`;
    })
    .toBe("billing/pod-a");
  await expect(page).toHaveURL(/instanceService=billing/);
  await select.selectOption({ label: "orders / pod-a" });
  await expect
    .poll(() => {
      const q = lastSeries("process.cpu.time");
      return `${q?.get("service")}/${q?.get("instance")}`;
    })
    .toBe("orders/pod-a");
});

test("nothing stored yet explains how to get metrics", async ({ page }) => {
  mock.metrics.empty = true;
  await page.goto(url("metrics"));
  await expect(page.getByTestId("metrics-no-data")).toContainText(
    "No metrics stored yet",
  );
});

test("the window control, service and environment narrow every query", async ({
  page,
}) => {
  mock.environments = ["production", "staging"].map((name) => ({
    name,
    unset: false,
    services: ["orders"],
    lastSeenUnixMs: Date.now(),
  }));
  await page.goto(url("metrics"));
  await expect(chart(page, "process.cpu.time")).toBeVisible();
  const first = lastSeries("process.cpu.time");
  expect(
    Number(first?.get("toUnixMs")) - Number(first?.get("fromUnixMs")),
  ).toBe(60 * 60_000);

  const before = seriesRequests("process.cpu.time").length;
  await page
    .getByTestId("metrics-window")
    .getByRole("button", { name: "15 min" })
    .click();
  await expect
    .poll(() => seriesRequests("process.cpu.time").length)
    .toBeGreaterThan(before);
  const narrowed = lastSeries("process.cpu.time");
  expect(
    Number(narrowed?.get("toUnixMs")) - Number(narrowed?.get("fromUnixMs")),
  ).toBe(15 * 60_000);

  await page.getByTestId("service-select").selectOption("orders");
  await page.getByTestId("environment-select").selectOption("production");
  await expect
    .poll(() => {
      const q = lastSeries("process.cpu.time");
      return `${q?.get("service")}/${q?.get("environment")}`;
    })
    .toBe("orders/production");
  const catalog = mock.requests.filter((r) => r.startsWith("metrics/catalog"));
  expect(catalog.at(-1)).toContain("service=orders");
  expect(catalog.at(-1)).toContain("environment=production");
});

test("filters by instance, aggregates across replicas, and splits one line per instance", async ({
  page,
}) => {
  await page.goto(url("metrics"));
  await expect(chart(page, "process.cpu.time")).toBeVisible();
  const select = page.getByTestId("metrics-instance");
  await expect(select.locator("option")).toHaveText([
    "All instances",
    "orders / pod-a",
    "orders / pod-b",
  ]);

  // Aggregation across replicas.
  await page.getByTestId("metrics-aggregation").selectOption("max");
  await expect
    .poll(() => lastSeries("process.memory.usage")?.get("aggregation"))
    .toBe("max");
  await expect(
    panel(page, "process.memory.usage").getByTestId("metric-meaning"),
  ).toContainText("busiest instance (max)");

  // One line per instance.
  await page.getByTestId("metrics-split").check();
  await expect
    .poll(() => lastSeries("process.memory.usage")?.get("by"))
    .toBe("instance");
  await expect(
    panel(page, "process.memory.usage").getByTestId("metric-meaning"),
  ).toContainText("one line per instance");
  await expect(page.getByTestId("metrics-aggregation")).toBeDisabled();

  // A single instance.
  await page.getByTestId("metrics-split").uncheck();
  await select.selectOption({ label: "orders / pod-b" });
  await expect
    .poll(() => {
      const q = lastSeries("process.memory.usage");
      return `${q?.get("service")}/${q?.get("instance")}`;
    })
    .toBe("orders/pod-b");
  await expect(
    panel(page, "process.memory.usage").getByTestId("metric-meaning"),
  ).toContainText("instance pod-b");
  await expect(page.getByTestId("metrics-split")).toBeDisabled();
  await expect(page).toHaveURL(/instance=pod-b/);
});

test("says when instance lines were cut at 20, and when the receiver dropped series", async ({
  page,
}) => {
  mock.metrics.instances = Array.from({ length: 25 }, (_, i) => `pod-${i}`);
  mock.metrics.overSeriesCap = 12;
  await page.goto(url("metrics?by=instance"));
  await expect(
    panel(page, "process.memory.usage").getByTestId("metric-capped"),
  ).toHaveText("showing 20 of 25 instances (most data first)");
  await expect(page.getByTestId("metrics-capped")).toContainText(
    "12 points dropped: series limit reached",
  );
});

test("a click on a chart opens the requests of that minute in the same service and environment", async ({
  page,
}) => {
  mock.environments = ["production", "staging"].map((name) => ({
    name,
    unset: false,
    services: ["orders"],
    lastSeenUnixMs: Date.now(),
  }));
  await page.goto(url("metrics?service=orders&environment=production"));
  const over = chart(page, "process.cpu.time").locator(".u-over");
  await expect(over).toBeVisible();
  const series = lastSeries("process.cpu.time");
  const start = Number(series?.get("fromUnixMs"));
  const end = Number(series?.get("toUnixMs"));
  const box = await over.boundingBox();
  if (box === null) throw new Error("the chart has no box");
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);

  await expect(page).toHaveURL(/#\/requests\?/);
  const hash = new URL(page.url()).hash;
  const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  expect(params.get("service")).toBe("orders");
  expect(params.get("environment")).toBe("production");
  const from = Number(params.get("fromUnixMs"));
  const to = Number(params.get("toUnixMs"));
  // One minute bucket, in the middle of the chart.
  expect(to - from + 1).toBe(60_000);
  expect(from % 60_000).toBe(0);
  expect(from).toBeGreaterThan(start + 20 * 60_000);
  expect(to).toBeLessThan(end - 20 * 60_000);

  // The request list asks the API for exactly that window, in that service and environment.
  await expect
    .poll(() =>
      mock
        .traceRequests()
        .some(
          (q) =>
            q.get("fromUnixMs") === String(from) &&
            q.get("toUnixMs") === String(to) &&
            q.get("service") === "orders" &&
            q.get("environment") === "production",
        ),
    )
    .toBe(true);
});

test("dragging across a chart opens the requests of the whole range", async ({
  page,
}) => {
  await page.goto(url("metrics?service=orders"));
  const over = chart(page, "process.memory.usage").locator(".u-over");
  await expect(over).toBeVisible();
  const box = await over.boundingBox();
  if (box === null) throw new Error("the chart has no box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
  await page.mouse.up();

  await expect(page).toHaveURL(/#\/requests\?/);
  const hash = new URL(page.url()).hash;
  const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const span =
    Number(params.get("toUnixMs")) - Number(params.get("fromUnixMs"));
  // About 30% of an hour, in whole minutes.
  expect(span + 1).toBeGreaterThan(14 * 60_000);
  expect(span + 1).toBeLessThan(22 * 60_000);
  expect((span + 1) % 60_000).toBe(0);
  expect(params.get("service")).toBe("orders");
  expect(params.has("environment")).toBe(false);
});

test("a trace links to the metrics around it, and the page shows exactly that range", async ({
  page,
}) => {
  mock.metrics.service = "demo-service";
  mock.push(1);
  const id = (1).toString(16).padStart(32, "0");
  await page.goto(url(`traces/${id}`));
  const link = page.getByTestId("trace-metrics-link");
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/#\/metrics\?/);
  const hash = new URL(page.url()).hash;
  const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const from = Number(params.get("fromUnixMs"));
  const to = Number(params.get("toUnixMs"));
  expect(params.get("service")).toBe("demo-service");
  // The trace started a second ago: 15 minutes either side of it.
  expect(Math.abs(from - (Date.now() - 15 * 60_000))).toBeLessThan(10_000);
  expect(Math.abs(to - (Date.now() + 15 * 60_000))).toBeLessThan(10_000);

  await expect(page.getByTestId("metrics-range")).toBeVisible();
  await expect(page.getByTestId("metrics-window")).toHaveCount(0);
  await expect(chart(page, "process.cpu.time")).toBeVisible();
  const q = lastSeries("process.cpu.time");
  expect(q?.get("fromUnixMs")).toBe(String(from));
  expect(q?.get("toUnixMs")).toBe(String(to));

  await page.getByTestId("metrics-reset-range").click();
  await expect(page.getByTestId("metrics-window")).toBeVisible();
  await expect(page.getByTestId("metrics-range")).toHaveCount(0);
});

test("a trace page has no metrics link when the server stores none", async ({
  page,
}) => {
  mock.metricsAvailable = false;
  mock.push(1);
  await page.goto(url(`traces/${(1).toString(16).padStart(32, "0")}`));
  await expect(page.getByTestId("trace-header")).toBeVisible();
  await expect(page.getByTestId("trace-metrics-link")).toHaveCount(0);
});
