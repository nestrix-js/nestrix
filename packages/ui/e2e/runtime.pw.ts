import type { Server } from "node:http";
import type { RuntimeSample } from "@nestrix-js/protocol";
import { expect, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

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
});

/** `count` samples, 10 s apart, ending now, with a slow spike in the last one. */
function samples(count: number): RuntimeSample[] {
  const end = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    timeUnixMs: end - (count - 1 - i) * 10_000,
    eventLoopP50Ms: 1.2,
    eventLoopP99Ms: i === count - 1 ? 85 : 4.5,
    eventLoopMaxMs: i === count - 1 ? 120 : 9,
    heapUsedBytes: 40_000_000 + i * 100_000,
    heapTotalBytes: 60_000_000,
    rssBytes: 120_000_000,
    externalBytes: 2_000_000,
    cpuUserPercent: 12.5,
    cpuSystemPercent: 2.5,
    activeResources: 6,
  }));
}

test("the runtime tab shows the tiles, four charts and the event loop note", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  mock.runtimeSamples = samples(30);
  await page.goto(url());
  await page.getByRole("link", { name: "Runtime" }).click();
  await expect(page).toHaveURL(/#\/runtime/);

  await expect(page.getByTestId("tile-loop-p99")).toContainText("85.0 ms");
  await expect(page.getByTestId("tile-rss")).toContainText("120.0 MB");
  await expect(page.getByTestId("tile-cpu")).toContainText("15%");
  await expect(page.getByTestId("tile-handles")).toContainText("6");
  await expect(page.getByTestId("tile-uptime")).toContainText("2.0 h");
  await expect(page.getByTestId("tile-node")).toContainText("v26.0.0");

  for (const id of ["eventloop", "memory", "cpu", "handles"]) {
    await expect(page.getByTestId(`chart-${id}`)).toHaveAttribute(
      "data-points",
      "30",
    );
    await expect(
      page.getByTestId(`chart-${id}`).locator("canvas"),
    ).toBeVisible();
  }
  await expect(page.getByTestId("runtime-note")).toContainText(
    "how late the Node.js event loop",
  );
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("before the first sample the page says so and shows no values", async ({
  page,
}) => {
  mock.runtimeSamples = [];
  await page.goto(url("runtime"));
  await expect(page.getByTestId("runtime-empty")).toBeVisible();
  await expect(page.getByTestId("tile-heap")).toContainText("-");
});

test("the Runtime tab is hidden in the standalone server and never requests runtime", async ({
  page,
}) => {
  mock.mode = "standalone";
  await page.goto(url());
  await expect(page.getByRole("link", { name: "SLOs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Runtime" })).toHaveCount(0);
  await page.goto(url("runtime"));
  await expect(page.getByTestId("runtime-unavailable")).toBeVisible();
  expect(mock.requests.some((r) => r.startsWith("runtime"))).toBe(false);
});

test("the Runtime tab is hidden when meta says it is unavailable", async ({
  page,
}) => {
  mock.runtimeAvailable = false;
  await page.goto(url());
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(page.getByRole("link", { name: "Runtime" })).toHaveCount(0);
});
