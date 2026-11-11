import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations } from "./helpers.ts";
import {
  DB_SPANS,
  DB_TRACE_ID,
  dbTrace,
  LINKED_TRACE_ID,
  linkedTrace,
  MISSING_TRACE_ID,
  OTHER_SQL,
  REPEATED_SQL,
} from "./mock-db-trace.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
test.beforeAll(async () => {
  ({ server, origin } = await startServer());
});
test.afterAll(() => {
  server.close();
});

/** Serves the database trace and the one it links to; any other id is a 404. */
async function openDbTrace(page: Page) {
  await recordViolations(page);
  await page.route("**/api/v1/trace?*", (route) => {
    const id = new URL(route.request().url()).searchParams.get("id");
    const body =
      id === DB_TRACE_ID
        ? dbTrace
        : id === LINKED_TRACE_ID
          ? linkedTrace
          : null;
    return route.fulfill({
      status: body ? 200 : 404,
      contentType: "application/json",
      body: JSON.stringify(
        body ?? { error: { code: "not_found", message: "Trace not found" } },
      ),
    });
  });
  await page.goto(`${origin}${BASE_PATH}/#/traces/${DB_TRACE_ID}`);
  await expect(page.getByTestId("span-row").first()).toBeVisible();
}

const row = (page: Page, spanId: string) =>
  page.locator(`[data-testid="span-row"][data-span-id="${spanId}"]`);

test("database spans over 100 ms are highlighted, others are not", async ({
  page,
}) => {
  await openDbTrace(page);
  const slow = await page
    .locator('[data-testid="span-row"][data-slow="true"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-span-id")));
  // Only the 150 ms query: the 99.5 ms query is fast, and the 60 ms span is not a database span.
  expect(slow).toEqual([DB_SPANS.slow]);
  await expect(row(page, DB_SPANS.slow).getByTestId("span-bar")).toHaveClass(
    /bg-warning/,
  );
  await expect(
    row(page, DB_SPANS.fastLegacy).getByTestId("span-bar"),
  ).not.toHaveClass(/bg-warning/);
  expect(await violations(page)).toEqual([]);
});

test("the Queries panel lists repeated statements with count and total time", async ({
  page,
}) => {
  await openDbTrace(page);
  const items = page.getByTestId("query-item");
  // Three identical queries repeat; the statement run twice does not.
  await expect(items).toHaveCount(1);
  await expect(items.first().getByTestId("query-text")).toHaveText(
    REPEATED_SQL,
  );
  await expect(items.first().getByTestId("query-count")).toHaveText("3x");
  await expect(items.first().getByTestId("query-total")).toHaveText("30.0 ms");
  expect(OTHER_SQL).not.toBe(REPEATED_SQL);
});

test("picking a statement highlights its spans and opens the first; picking again clears", async ({
  page,
}) => {
  await openDbTrace(page);
  const highlighted = page.locator(
    '[data-testid="span-row"][data-highlighted="true"]',
  );
  await expect(highlighted).toHaveCount(0);
  await page.getByTestId("query-item").click();
  const ids = await highlighted.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-span-id")),
  );
  expect(ids).toEqual(DB_SPANS.repeated);
  await expect(row(page, DB_SPANS.repeated[0] as string)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("detail-name")).toHaveText("SELECT users");
  await page.getByTestId("query-item").click();
  await expect(highlighted).toHaveCount(0);
});

test("picking a statement expands collapsed ancestors", async ({ page }) => {
  await openDbTrace(page);
  await row(page, DB_SPANS.linked).getByTestId("span-toggle").click();
  await expect(row(page, DB_SPANS.repeated[0] as string)).toHaveCount(0);
  await page.getByTestId("query-item").click();
  await expect(row(page, DB_SPANS.repeated[0] as string)).toBeVisible();
});

test("span links: a trace in the store opens, a missing one is text", async ({
  page,
}) => {
  await openDbTrace(page);
  await row(page, DB_SPANS.linked).click();
  const links = page.getByTestId("span-link");
  await expect(links).toHaveCount(2);

  const stored = links.filter({ hasText: LINKED_TRACE_ID });
  await expect(stored).toHaveAttribute("data-in-store", "true");
  const missing = links.filter({ hasText: MISSING_TRACE_ID });
  await expect(missing).toHaveAttribute("data-in-store", "false");
  await expect(missing).toContainText("not in the store");
  await expect(missing.getByRole("link")).toHaveCount(0);

  await stored.getByRole("link").click();
  await expect(page.getByTestId("trace-id")).toHaveText(LINKED_TRACE_ID);
  await expect(page.getByTestId("trace-title")).toHaveText("orders process");
});
