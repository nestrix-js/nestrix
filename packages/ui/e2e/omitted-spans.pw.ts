// P13-03: the banner and the "(omitted N spans)" row for a trace whose spans were capped.
import type { Server } from "node:http";
import type { DroppedSpans, TraceResponse } from "@nestrix-js/protocol";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import { BASE_PATH, startServer } from "./serve.ts";

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

const SHOTS = "test-results";

async function open(page: Page, dropped: DroppedSpans | undefined) {
  await recordViolations(page);
  const problems = watch(page);
  const body: TraceResponse = { ...trace };
  if (dropped) body.droppedSpans = dropped;
  else delete body.droppedSpans;
  await page.route("**/api/v1/trace?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
  await page.goto(`${origin}${BASE_PATH}/#/traces/${trace.traceId}`);
  await expect(page.getByTestId("trace-title")).toBeVisible();
  return problems;
}

test("app-only: banner, kinds and the omitted row right under the root", async ({
  page,
}) => {
  const problems = await open(page, {
    total: 12,
    byKind: { db: 7, redis: 3, other: 2 },
    byServer: 0,
  });
  await expect(page.getByTestId("omitted-headline")).toHaveText(
    "This trace has 12 more spans that were counted but not recorded.",
  );
  await expect(page.getByTestId("omitted-split")).toHaveText(
    "12 over the app's span limit",
  );
  await expect(page.getByTestId("omitted-kinds").locator("li")).toHaveText([
    "Database: 7",
    "Redis: 3",
    "Other: 2",
  ]);
  await expect(page.getByTestId("omitted-docs-link")).toHaveAttribute(
    "href",
    /packages\/nestjs\/README\.md/,
  );
  const omitted = page.getByTestId("omitted-row");
  await expect(omitted).toHaveText("(omitted 12 spans)");
  // Muted, not a clickable span row: clicking it opens nothing and selects nothing.
  await omitted.click();
  await expect(page.getByTestId("span-detail")).toHaveCount(0);
  await expect(
    page.locator('[data-testid="span-row"][aria-selected="true"]'),
  ).toHaveCount(0);
  // Order: root row, then the omitted row, then the root's children.
  const order = await page
    .locator('[data-testid="span-row"], [data-testid="omitted-row"]')
    .evaluateAll((els) =>
      els.map((el) =>
        el.getAttribute("data-testid") === "omitted-row"
          ? "omitted"
          : (el.querySelector('[data-testid="span-name"]')?.textContent ?? ""),
      ),
    );
  expect(order.slice(0, 3)).toEqual([
    "GET /orders/:id",
    "omitted",
    "guard AuthGuard",
  ]);
  // The span count in the header stays the recorded spans.
  await expect(page.getByTestId("trace-span-count")).toHaveText("4 spans");
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("server-only names the server side only", async ({ page }) => {
  await open(page, { total: 5, byKind: {}, byServer: 5 });
  await expect(page.getByTestId("omitted-split")).toHaveText(
    "5 over the server's",
  );
  await expect(page.getByTestId("omitted-kinds")).toHaveCount(0);
  await expect(page.getByTestId("omitted-row")).toHaveText("(omitted 5 spans)");
});

test("both sides, singular wording, and the row survives collapsing the root", async ({
  page,
}) => {
  await open(page, { total: 4, byKind: { app: 3 }, byServer: 1 });
  await expect(page.getByTestId("omitted-split")).toHaveText(
    "3 over the app's span limit, 1 over the server's",
  );
  await expect(page.getByTestId("omitted-kinds")).toHaveText(
    "App code (Nest): 3",
  );
  await page.getByTestId("span-toggle").first().click();
  await expect(page.getByTestId("span-row")).toHaveCount(1);
  await expect(page.getByTestId("omitted-row")).toHaveText("(omitted 4 spans)");
});

test("a trace without droppedSpans has neither banner nor row", async ({
  page,
}) => {
  await open(page, undefined);
  await expect(page.getByTestId("span-row")).toHaveCount(4);
  await expect(page.getByTestId("omitted-banner")).toHaveCount(0);
  await expect(page.getByTestId("omitted-row")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`banner in ${scheme} mode (screenshot)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, {
      total: 12,
      byKind: { db: 7, redis: 3, other: 2 },
      byServer: 4,
    });
    await expect(page.getByTestId("omitted-banner")).toBeVisible();
    await page.screenshot({
      path: `${SHOTS}/omitted-spans-${scheme}.png`,
      fullPage: true,
    });
  });
}
