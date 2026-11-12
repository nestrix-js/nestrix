import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/${hash}`;
const MIN = 60_000;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

test("dependencies: targets by total time with sparklines, a window switch and a link to an example trace", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url("dependencies"));
  const rows = page.getByTestId("dependency-row");
  await expect(rows).toHaveCount(4);
  // Total time: stripe 6.6 s, postgres 4.8 s, redis 0.54 s, queue 0.15 s.
  await expect(rows.nth(0)).toContainText("api.stripe.com");
  await expect(rows.nth(1)).toContainText("postgresql shop");
  await expect(rows.nth(2)).toContainText("redis");
  await expect(rows.nth(3)).toContainText("queue emails");
  await expect(rows.nth(1)).toContainText("240");
  await expect(rows.nth(1)).toContainText("12 (5.0%)");
  await expect(rows.nth(1)).toContainText("90.0 ms");
  await expect(rows.nth(1)).toContainText("4.80 s");
  await expect(rows.nth(0).getByTestId("sparkline")).toHaveCount(2);
  await expect(rows.nth(0).getByTestId("sparkline").first()).toHaveAttribute(
    "data-points",
    "15",
  );
  await expect(page.getByTestId("dependencies-note")).toContainText(
    "sampled traces",
  );

  await page.getByRole("button", { name: "60 min", exact: true }).click();
  await expect(rows.nth(0).getByTestId("sparkline").first()).toHaveAttribute(
    "data-points",
    "12",
  );
  expect(mock.requests).toContain("dependencies?windowMinutes=60");

  // The name opens the trace of the slowest call.
  await rows.nth(0).getByRole("link", { name: "api.stripe.com" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/traces/${(13).toString(16).padStart(32, "0")}`),
  );
  expect(await violations(page)).toEqual([]);
  expect(
    problems.filter((p) => !p.includes("HTTP 404")),
    "only the mock's missing trace answers 404",
  ).toEqual([]);
});

test("dependencies: empty and failing answers", async ({ page }) => {
  mock.failing.add("dependencies");
  await page.goto(url("dependencies"));
  await expect(page.getByRole("alert")).toContainText(
    "Could not load dependencies",
  );
});

async function dragOver(page: Page, from: number, to: number) {
  const over = page.getByTestId("timeline").locator(".u-over");
  const box = await over.boundingBox();
  if (!box) throw new Error("no plot area");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from + to) / 2), y, { steps: 4 });
  await page.mouse.move(box.x + box.width * to, y, { steps: 4 });
  await page.mouse.up();
}

const lastTracesQuery = () => {
  const queries = mock.traceRequests();
  return queries[queries.length - 1] ?? new URLSearchParams();
};

test("timeline: draws the buckets above the list and follows the list's filters", async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto(url("?status=5xx&route=%2Forders"));
  await expect(page.getByTestId("timeline")).toHaveAttribute(
    "data-buckets",
    "15",
  );
  await expect(page.getByTestId("timeline").locator("canvas")).toHaveCount(1);
  const timelineRequest = () =>
    mock.requests.filter((r) => r.startsWith("traces/timeline"));
  await expect.poll(() => timelineRequest().length).toBeGreaterThan(0);
  const asked = new URLSearchParams(timelineRequest()[0]?.split("?")[1]);
  expect(asked.get("windowMinutes")).toBe("15");
  expect(asked.get("status")).toBe("5xx");
  expect(asked.get("route")).toBe("/orders");
  expect(asked.has("fromUnixMs")).toBe(false);

  await page.getByRole("button", { name: "60 min", exact: true }).click();
  await expect(page.getByTestId("timeline")).toHaveAttribute(
    "data-buckets",
    "12",
  );
  expect(problems).toEqual([]);
});

test("timeline: dragging over the chart sets a time range on the list, clear removes it", async ({
  page,
}) => {
  await page.goto(url());
  await expect(page.getByTestId("timeline")).toHaveAttribute(
    "data-buckets",
    "15",
  );
  await expect(page.getByTestId("timeline").locator(".u-over")).toBeVisible();
  await dragOver(page, 0.3, 0.6);

  await expect(page.getByTestId("timeline-range")).toBeVisible();
  await expect
    .poll(() => lastTracesQuery().has("fromUnixMs"), { timeout: 10_000 })
    .toBe(true);
  const q = lastTracesQuery();
  const from = Number(q.get("fromUnixMs"));
  const to = Number(q.get("toUnixMs"));
  expect(to).toBeGreaterThan(from);
  // Whole buckets: a multiple of a minute wide, starting on a minute.
  expect(from % MIN).toBe(0);
  expect((to + 1 - from) % MIN).toBe(0);
  expect((to + 1 - from) / MIN).toBeGreaterThanOrEqual(4);
  await expect(page).toHaveURL(/fromUnixMs=/);
  // The mock's requests are all newer than the range.
  await expect(
    page.getByText("No requests match these filters."),
  ).toBeVisible();
  // The timeline itself keeps showing the whole window.
  const timelineRequests = mock.requests.filter((r) =>
    r.startsWith("traces/timeline"),
  );
  expect(timelineRequests.every((r) => !r.includes("fromUnixMs"))).toBe(true);

  await page.getByTestId("timeline-range").click();
  await expect(page.getByTestId("timeline-range")).toHaveCount(0);
  await expect
    .poll(() => lastTracesQuery().has("fromUnixMs"), { timeout: 10_000 })
    .toBe(false);
  await expect(
    page.getByTestId("requests").locator("tbody tr").first(),
  ).toBeVisible();
});

test("timeline: clicking a bar selects its bucket", async ({ page }) => {
  await page.goto(url());
  await expect(page.getByTestId("timeline")).toHaveAttribute(
    "data-buckets",
    "15",
  );
  const over = page.getByTestId("timeline").locator(".u-over");
  await expect(over).toBeVisible();
  const box = await over.boundingBox();
  if (!box) throw new Error("no plot area");
  // Bucket 3 of 15 holds requests in the mock's timeline.
  await page.mouse.click(
    box.x + (box.width * 3.5) / 15,
    box.y + box.height / 2,
  );
  await expect(page.getByTestId("timeline-range")).toBeVisible();
  await expect
    .poll(() => lastTracesQuery().has("fromUnixMs"), { timeout: 10_000 })
    .toBe(true);
  const q = lastTracesQuery();
  expect(Number(q.get("toUnixMs")) + 1 - Number(q.get("fromUnixMs"))).toBe(MIN);
});
