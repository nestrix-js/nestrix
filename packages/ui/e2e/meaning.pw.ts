// Design batch "meaning": the sampling caveat is said once with its rate, the not-found trace
// copy follows the mode, the shared SLO scale and the destructive Delete.
import type { Server } from "node:http";
import { expect, test } from "@playwright/test";

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
  mock.mode = "standalone";
});

test("the sampling chip states the rate, explains it, and is absent where nothing is sampled", async ({
  page,
}) => {
  await page.goto(url("requests"));
  const chip = page.getByTestId("sampling-notice");
  await expect(chip).toHaveText("traces sampled at 25%");
  await expect(chip).toHaveAttribute("title", /25%/);
  for (const route of ["slos", "alerts", "settings", "logs"]) {
    await page.goto(url(route));
    await expect(page.getByTestId("connection")).toHaveAttribute(
      "data-state",
      "live",
    );
    await expect(page.getByTestId("sampling-notice")).toHaveCount(0);
  }
});

test("a page whose header says 'from sampled traces' does not repeat it on its cards", async ({
  page,
}) => {
  await page.goto(url("dependencies"));
  await expect(page.getByTestId("page-header")).toContainText(
    "from sampled traces",
  );
  await expect(page.getByTestId("dependency-row").first()).toBeVisible();
  // Header only: no tile or card repeats the same words.
  await expect(page.getByTestId("source")).toHaveCount(1);
  await expect(page.getByTestId("dependencies-note")).toContainText(
    "sampled traces",
  );
});

test("a card that differs from its page keeps its own source line", async ({
  page,
}) => {
  await page.goto(url("classes"));
  await expect(page.getByTestId("page-header")).toContainText(
    "counted before sampling",
  );
  await expect(page.getByTestId("card-class-table")).toBeVisible();
  // "estimated from sampled traces" is real information on a counted page.
  await expect(
    page
      .getByTestId("source")
      .filter({ hasText: "estimated from sampled traces" })
      .first(),
  ).toBeVisible();
});

test("trace not found: the copy follows the mode and the id sits inside the card", async ({
  page,
}) => {
  const id = "ab".repeat(16);
  await page.goto(url(`traces/${id}`));
  const card = page.getByTestId("trace-evicted");
  await expect(card).toContainText("retention period");
  await expect(card).not.toContainText("no longer in memory");
  await expect(card.getByTestId("trace-id")).toHaveText(id);

  mock.mode = "embedded";
  await page.reload();
  await expect(page.getByTestId("trace-evicted")).toContainText(
    "no longer in memory",
  );
});

test("SLOs: one shared burn scale, the marker explained once, Delete styled as destructive", async ({
  page,
}) => {
  const slo = (id: string, burn1h: number) => ({
    id,
    name: `SLO ${id}`,
    service: "orders",
    environment: null,
    route: null,
    kind: "availability" as const,
    latencyThresholdMs: null,
    objective: 0.999,
    windowDays: 30 as const,
    createdAtUnixMs: 0,
    updatedAtUnixMs: 0,
    status: {
      totalRequests: 1000,
      goodRequests: 990,
      badRequests: 10,
      attainment: 0.99,
      errorBudget: {
        totalRequests: 1,
        remainingRequests: -9,
        remainingFraction: -9,
      },
      burnRate: { "1h": burn1h, "6h": 1 },
      breached: true,
    },
  });
  mock.slos = [slo("1", 20), slo("2", 2)];
  await page.goto(url("slos"));
  await expect(page.getByTestId("slo")).toHaveCount(2);
  // The same 1h rate gives a bar that is a tenth as long on the card with the smaller rate.
  const widths = await page.getByTestId("burn-chart").evaluateAll((els) =>
    els.map((el) => {
      const bar = el.querySelector("span.relative > span") as HTMLElement;
      return bar.getBoundingClientRect().width;
    }),
  );
  expect(widths[0]).toBeGreaterThan(widths[1] * 5);
  await expect(page.getByTestId("burn-note")).toHaveCount(1);
  await expect(page.getByText("Marker: 1x")).toHaveCount(0);
  // The ring shows the overspend with a percent sign.
  await expect(page.getByTestId("slo").first()).toContainText("−900%");
  await expect(page.getByTestId("slo").first()).toContainText("over budget");
  const color = await page
    .getByRole("button", { name: "Delete" })
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  const normal = await page
    .getByRole("button", { name: "Edit" })
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(color).not.toBe(normal);
});
