import type { Server } from "node:http";
import { expect, test } from "@playwright/test";

import { requestRows } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

// Design round 2, tables: a bar and its number sit in one cell, under that column's header, and
// the Requests table box ends on a whole row.
let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/${hash}`;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
  mock.mode = "standalone";
});

test("the duration bar of a request sits under the Duration header, with its number", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("requests"));
  await expect(requestRows(page).first()).toBeVisible();
  const header = await page
    .getByRole("columnheader", { name: "Duration" })
    .boundingBox();
  const bar = await page.getByTestId("duration-bar").first().boundingBox();
  const cell = page.getByRole("row").nth(1).getByRole("cell").nth(4);
  const cellText = await cell.innerText();
  expect(header).not.toBeNull();
  expect(bar).not.toBeNull();
  // The bar's track lies inside the header's horizontal extent and ends at its right edge.
  const track = await page
    .getByTestId("duration-bar")
    .first()
    .locator("..")
    .boundingBox();
  expect(track?.x).toBeGreaterThanOrEqual((header?.x ?? 0) - 1);
  expect((track?.x ?? 0) + (track?.width ?? 0)).toBeLessThanOrEqual(
    (header?.x ?? 0) + (header?.width ?? 0) + 1,
  );
  expect(cellText).toMatch(/\d+ ms/);
});

for (const height of [600, 900]) {
  test(`the Requests table box ends on a whole row at ${height} px high`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height });
    await page.goto(url("requests"));
    await expect(requestRows(page).first()).toBeVisible();
    const fit = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="requests"]')
        ?.parentElement as HTMLElement;
      const head =
        box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      const rows = [...box.querySelectorAll("tbody tr")].map(
        (r) => r.getBoundingClientRect().height,
      );
      const whole = (box.clientHeight - head) / (rows[0] ?? 1);
      return { whole, rows: rows.length };
    });
    expect(fit.rows).toBeGreaterThan(16);
    expect(Math.abs(fit.whole - Math.round(fit.whole))).toBeLessThan(0.05);
  });
}

test("the settings table uses the shared header", async ({ page }) => {
  mock.tokens = [
    {
      id: "7",
      name: "ci reader",
      prefix: "nxt_Zz9-",
      createdAtUnixMs: Date.now() - 86_400_000,
      lastUsedAtUnixMs: null,
      revokedAtUnixMs: null,
    },
  ];
  await page.goto(url("settings"));
  const head = page.getByTestId("tokens").locator("th").first();
  await expect(head).toHaveAttribute("data-slot", "table-head");
  const other = await head.evaluate((el) => getComputedStyle(el).fontSize);
  expect(other).toBe("14px");
});
