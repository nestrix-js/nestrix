// P9-07: the trace view's Logs panel and the log markers on the waterfall, with mocked API answers.
import type { Server } from "node:http";
import type { TraceLogsResponse } from "@nestrix-js/protocol";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations } from "./helpers.ts";
import { DB_SPANS, DB_TRACE_ID, dbTrace } from "./mock-db-trace.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
test.beforeAll(async () => {
  ({ server, origin } = await startServer());
});
test.afterAll(() => {
  server.close();
});

const T0 = dbTrace.spans[0]?.startTimeUnixMs ?? 0;
const HANDLER = DB_SPANS.linked; // span 2, parent of the queries
const RENDER = DB_SPANS.slowNotDb; // span 8, child of the handler

const LOGS: TraceLogsResponse = {
  traceId: DB_TRACE_ID,
  truncated: false,
  items: [
    {
      timeUnixMs: T0 + 2,
      severity: 9,
      level: "log",
      context: "OrdersController",
      message: "listing orders",
      spanId: HANDLER,
    },
    {
      timeUnixMs: T0 + 60,
      severity: 13,
      level: "warn",
      context: "OrdersRepository",
      message: "slow query",
      spanId: DB_SPANS.slow,
    },
    {
      timeUnixMs: T0 + 100,
      severity: 5,
      level: "debug",
      message: "no span here",
    },
    {
      timeUnixMs: T0 + 330,
      severity: 17,
      level: "error",
      context: "Renderer",
      message: "render failed <img src=x onerror=alert(1)>",
      spanId: RENDER,
    },
    {
      timeUnixMs: T0 + 340,
      severity: 9,
      level: "",
      message: "another render line",
      spanId: RENDER,
    },
  ],
};

async function open(page: Page, logs: TraceLogsResponse | number) {
  await recordViolations(page);
  await page.route("**/api/v1/trace?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(dbTrace),
    }),
  );
  await page.route("**/api/v1/trace/logs?*", (route) =>
    typeof logs === "number"
      ? route.fulfill({
          status: logs,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "internal", message: "boom" },
          }),
        })
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(logs),
        }),
  );
  await page.goto(`${origin}${BASE_PATH}/#/traces/${DB_TRACE_ID}`);
  await expect(page.getByTestId("span-row").first()).toBeVisible();
}

const row = (page: Page, spanId: string) =>
  page.locator(`[data-testid="span-row"][data-span-id="${spanId}"]`);

test("lists the trace's lines in time order with level colouring", async ({
  page,
}) => {
  await open(page, LOGS);
  const panel = page.getByTestId("logs-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading")).toHaveText("Logs (5)");
  const lines = panel.getByTestId("log-line");
  await expect(lines).toHaveCount(5);
  await expect(lines.getByTestId("log-message")).toHaveText([
    "listing orders",
    "slow query",
    "no span here",
    "render failed <img src=x onerror=alert(1)>",
    "another render line",
  ]);
  expect(
    await lines.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-tone")),
    ),
  ).toEqual(["info", "warn", "debug", "error", "info"]);
  await expect(lines.nth(3).getByTestId("log-level")).toHaveClass(
    /text-destructive/,
  );
  await expect(lines.nth(1).getByTestId("log-level")).toHaveClass(
    /text-warning/,
  );
  // An empty level falls back to the severity's name.
  await expect(lines.nth(4).getByTestId("log-level")).toHaveText("info");
  await expect(lines.nth(0).getByTestId("log-time")).toHaveText("+2.0 ms");
  await expect(lines.nth(0).getByTestId("log-context")).toHaveText(
    "[OrdersController]",
  );
  // A message is text: markup in it is not rendered.
  await expect(panel.locator("img")).toHaveCount(0);
  // A line without a span is not clickable.
  await expect(lines.nth(2).locator("xpath=self::button")).toHaveCount(0);
  await expect(page.getByTestId("logs-truncated")).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test("marks the rows of spans that logged, with ticks at each line's time", async ({
  page,
}) => {
  await open(page, LOGS);
  const marked = await page
    .locator('[data-testid="span-row"]:has([data-testid="log-marker"])')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-span-id")));
  expect(marked.sort()).toEqual([HANDLER, DB_SPANS.slow, RENDER].sort());
  const renderMarker = row(page, RENDER).getByTestId("log-marker");
  await expect(renderMarker).toHaveText("2");
  await expect(renderMarker).toHaveAttribute("data-tone", "error");
  await expect(
    row(page, DB_SPANS.slow).getByTestId("log-marker"),
  ).toHaveAttribute("data-tone", "warn");
  await expect(row(page, RENDER).getByTestId("log-tick")).toHaveCount(2);
  await expect(
    row(page, DB_SPANS.repeated[0] as string).getByTestId("log-marker"),
  ).toHaveCount(0);
});

test("clicking a line selects its span, opening collapsed ancestors", async ({
  page,
}) => {
  await open(page, LOGS);
  // Collapse the handler: the render span has no row.
  await row(page, HANDLER).getByTestId("span-toggle").click();
  await expect(row(page, RENDER)).toHaveCount(0);
  await page.getByTestId("log-line").nth(3).click();
  await expect(row(page, RENDER)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("span-detail")).toBeVisible();
  await expect(page.getByTestId("detail-name")).toHaveText("render");
  // The selected span's lines are highlighted in the panel.
  expect(
    await page
      .locator('[data-testid="log-line"][data-selected="true"]')
      .evaluateAll((els) => els.map((e) => e.textContent)),
  ).toHaveLength(2);
  // Another line moves the selection.
  await page.getByTestId("log-line").nth(1).click();
  await expect(row(page, DB_SPANS.slow)).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("says when the per-trace cap was reached", async ({ page }) => {
  await open(page, { ...LOGS, truncated: true });
  await expect(page.getByTestId("logs-truncated")).toBeVisible();
});

test("no panel without lines, and a failing logs request leaves the trace view intact", async ({
  page,
}) => {
  await open(page, { traceId: DB_TRACE_ID, items: [], truncated: false });
  await expect(page.getByTestId("waterfall")).toBeVisible();
  await expect(page.getByTestId("logs-panel")).toHaveCount(0);
  await page.unrouteAll();
  await open(page, 500);
  await expect(page.getByTestId("waterfall")).toBeVisible();
  await expect(page.getByTestId("trace-title")).toHaveText("GET /orders");
  await expect(page.getByTestId("logs-panel")).toHaveCount(0);
  await expect(page.getByTestId("log-marker")).toHaveCount(0);
});
