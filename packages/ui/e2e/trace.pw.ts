import type { Server } from "node:http";
import type { TraceResponse } from "@nestrix/protocol";
import { expect, type Page, test } from "@playwright/test";
import { recordViolations, violations, watch } from "./helpers.ts";
import { BASE_PATH, startServer } from "./serve.ts";
import { generateTrace } from "./trace-generate.ts";

// The protocol fixture is outside this project's TypeScript root, so it is loaded by path.
const fixtureUrl = new URL("../../protocol/fixtures/trace.ts", import.meta.url)
  .href;
const { trace } = (await import(fixtureUrl)) as { trace: TraceResponse };

let server: Server;
let origin: string;
test.beforeAll(async () => {
  ({ server, origin } = await startServer());
});
test.afterAll(() => {
  server.close();
});

/** Answers `api/v1/trace` for the given id from `body`; anything else goes to the real mock. */
async function serveTrace(page: Page, body: TraceResponse | 404) {
  await page.route("**/api/v1/trace?*", (route) =>
    body === 404
      ? route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "not_found", message: "Trace not found" },
          }),
        })
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        }),
  );
}

async function openTrace(page: Page, body: TraceResponse | 404, id: string) {
  await recordViolations(page);
  const problems = watch(page);
  await serveTrace(page, body);
  await page.goto(`${origin}${BASE_PATH}/#/traces/${id}`);
  return problems;
}

const rows = (page: Page) => page.getByTestId("span-row");

test("rows: names, nesting, kinds and error marks of the protocol fixture", async ({
  page,
}) => {
  const problems = await openTrace(page, trace, trace.traceId);
  await expect(rows(page)).toHaveCount(4);
  const seen = await rows(page).evaluateAll((els) =>
    els.map((el) => ({
      name: el.querySelector('[data-testid="span-name"]')?.textContent,
      kind: el.querySelector('[data-testid="span-kind"]')?.textContent,
      depth: el.getAttribute("data-depth"),
      level: el.getAttribute("aria-level"),
      error: el.getAttribute("data-error"),
      expanded: el.getAttribute("aria-expanded"),
    })),
  );
  expect(seen).toEqual([
    {
      name: "GET /orders/:id",
      kind: "server",
      depth: "0",
      level: "1",
      error: "true",
      expanded: "true",
    },
    {
      name: "guard AuthGuard",
      kind: "internal",
      depth: "1",
      level: "2",
      error: null,
      expanded: null,
    },
    {
      name: "OrdersController.getOrder",
      kind: "internal",
      depth: "1",
      level: "2",
      error: "true",
      expanded: "true",
    },
    {
      name: "GET",
      kind: "client",
      depth: "2",
      level: "3",
      error: "true",
      expanded: null,
    },
  ]);
  // The local root has a remote parent in the fixture: expected, so no marker.
  await expect(page.getByTestId("orphan-marker")).toHaveCount(0);
  await expect(page.getByTestId("waterfall")).toHaveAttribute(
    "role",
    "treegrid",
  );

  // Header.
  await expect(page.getByTestId("trace-title")).toHaveText("GET /orders/:id");
  await expect(page.getByTestId("trace-status")).toHaveText("500");
  await expect(page.getByTestId("trace-duration")).toHaveText("182 ms");
  await expect(page.getByTestId("trace-span-count")).toHaveText("4 spans");
  await expect(page.getByTestId("trace-id")).toHaveText(trace.traceId);
  // Scale header: five marks from 0 to the axis end.
  await expect(page.getByTestId("scale-tick")).toHaveCount(5);
  await expect(page.getByTestId("scale-tick").first()).toHaveText("0.00 ms");
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("bars sit on the trace time axis in proportion to start and duration", async ({
  page,
}) => {
  await openTrace(page, trace, trace.traceId);
  await expect(rows(page)).toHaveCount(4);
  const t0 = trace.spans[0]?.startTimeUnixMs as number;
  const total = 182.4;
  for (const [i, span] of trace.spans.entries()) {
    const row = rows(page).nth(
      // Display order is by tree: root, guard, handler, client = fixture order.
      i,
    );
    const bar = row.getByTestId("span-bar");
    const barBox = await bar.boundingBox();
    const cellBox = await bar.locator("..").boundingBox();
    if (!barBox || !cellBox) throw new Error("no layout");
    const left = ((span.startTimeUnixMs - t0) / total) * cellBox.width;
    const width = (span.durationMs / total) * cellBox.width;
    expect(barBox.x - cellBox.x).toBeCloseTo(left, 0);
    // A narrow bar is at least 2px wide.
    expect(barBox.width).toBeCloseTo(Math.max(width, 2), 0);
  }
});

test("collapse and expand hide and show descendants", async ({ page }) => {
  await openTrace(page, trace, trace.traceId);
  await expect(rows(page)).toHaveCount(4);
  const handler = rows(page).filter({ hasText: "OrdersController.getOrder" });
  await handler.getByTestId("span-toggle").click();
  await expect(rows(page)).toHaveCount(3);
  await expect(handler).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("waterfall")).toHaveAttribute(
    "aria-rowcount",
    "3",
  );
  await handler.getByTestId("span-toggle").click();
  await expect(rows(page)).toHaveCount(4);
});

test("selecting a row opens the detail panel with attributes, events and links", async ({
  page,
}) => {
  const problems = await openTrace(page, trace, trace.traceId);
  await expect(page.getByTestId("span-detail")).toHaveCount(0);
  await rows(page).filter({ hasText: "OrdersController" }).click();
  const detail = page.getByTestId("span-detail");
  await expect(detail.getByTestId("detail-name")).toHaveText(
    "OrdersController.getOrder",
  );
  await expect(detail).toContainText("internal");
  await expect(detail).toContainText("error");
  await expect(detail).toContainText("176 ms");
  // Attributes sorted by key.
  const keys = await detail
    .getByTestId("span-attributes")
    .locator("dt")
    .allTextContents();
  expect(keys).toEqual(["code.function.name", "nestrix.kind"]);
  // The exception event: type, message and the stack in Geist Mono.
  const event = detail.getByTestId("span-event");
  await expect(event).toContainText("BadGatewayException");
  await expect(event).toContainText("Payments service unavailable");

  await rows(page).first().click();
  const stack = page.getByTestId("exception-stack");
  await expect(stack).toContainText("OrdersService.load (orders.service.ts");
  expect(
    await stack.evaluate((el) => getComputedStyle(el).fontFamily),
  ).toContain("Geist Mono");

  // Links of the client span.
  await rows(page)
    .filter({ hasText: /^GET\s*client/ })
    .click();
  await expect(page.getByTestId("span-links")).toContainText(
    "4bf92f3577b34da6a3ce929d0e0e4736",
  );
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(page.getByTestId("span-detail")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("copy buttons put the trace id and the attributes on the clipboard", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "clipboard permissions are Chromium-only",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTrace(page, trace, trace.traceId);
  await page.getByRole("button", { name: "Copy trace id" }).click();
  await expect(
    page.getByRole("button", { name: "Copy trace id" }),
  ).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    trace.traceId,
  );
  await rows(page).first().click();
  await page.getByRole("button", { name: "Copy attributes" }).click();
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  ) as Record<string, unknown>;
  expect(copied["http.route"]).toBe("/orders/:id");
  expect(Object.keys(copied)).toEqual([...Object.keys(copied)].sort());
});

test("keyboard: arrows move, left and right collapse and expand, Enter opens", async ({
  page,
}) => {
  await openTrace(page, trace, trace.traceId);
  await expect(rows(page)).toHaveCount(4);
  await page.getByTestId("waterfall").focus();
  const selected = page.locator(
    '[data-testid="span-row"][aria-selected="true"]',
  );
  await expect(selected).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  await expect(selected).toContainText("GET /orders/:id");
  await page.keyboard.press("ArrowDown");
  await expect(selected).toContainText("guard AuthGuard");
  await page.keyboard.press("ArrowDown");
  await expect(selected).toContainText("OrdersController.getOrder");
  await page.keyboard.press("ArrowUp");
  await expect(selected).toContainText("guard AuthGuard");
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("ArrowLeft");
  await expect(rows(page)).toHaveCount(3);
  await expect(selected).toContainText("OrdersController.getOrder");
  await page.keyboard.press("ArrowRight");
  await expect(rows(page)).toHaveCount(4);
  await page.keyboard.press("ArrowRight");
  await expect(selected).toContainText(/^GET\s*client/);

  await expect(page.getByTestId("span-detail")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("detail-name")).toHaveText("GET");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("span-detail")).toHaveCount(0);
});

test("a trace with a span whose parent is missing marks it at the root", async ({
  page,
}) => {
  const body: TraceResponse = {
    ...trace,
    spans: trace.spans.map((s) =>
      s.name === "guard AuthGuard"
        ? { ...s, parentSpanId: "ffffffffffffffff" }
        : s,
    ),
  };
  await openTrace(page, body, trace.traceId);
  const guard = rows(page).filter({ hasText: "guard AuthGuard" });
  await expect(guard).toHaveAttribute("data-depth", "0");
  await expect(guard).toHaveAttribute("data-orphan", "true");
  await expect(guard.getByTestId("orphan-marker")).toHaveCount(1);
});

test("a 5,000-span trace renders only the visible rows and scrolls to the end", async ({
  page,
}) => {
  const big = generateTrace(5000);
  const problems = await openTrace(page, big, big.traceId);
  const grid = page.getByTestId("waterfall");
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByTestId("trace-span-count")).toHaveText("5000 spans");
  await expect(grid).toHaveAttribute("aria-rowcount", "5000");
  const initial = await rows(page).count();
  expect(initial).toBeGreaterThan(5);
  expect(initial).toBeLessThan(80);

  await grid.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // The last row in display order is the 5,000th.
  await expect(rows(page).last()).toHaveAttribute("aria-rowindex", "5000");
  expect(await rows(page).count()).toBeLessThan(80);
  expect(problems).toEqual([]);
});

test("an evicted trace says so and links back to the list", async ({
  page,
}) => {
  const problems = await openTrace(page, 404, "deadbeef".repeat(4));
  const evicted = page.getByTestId("trace-evicted");
  await expect(evicted).toContainText("Trace not found");
  await expect(evicted).toContainText("no longer in memory");
  await expect(page.getByTestId("trace-id")).toHaveText("deadbeef".repeat(4));
  await page.getByTestId("back-to-list").click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/");
  // The only failed request is the 404 the test provoked.
  expect(
    problems.filter(
      (p) => !p.includes("HTTP 404") && !p.includes("status of 404"),
    ),
  ).toEqual([]);
});
