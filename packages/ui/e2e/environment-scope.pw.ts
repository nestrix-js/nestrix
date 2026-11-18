// Audit: the selected environment is part of every list's identity (a switch never leaves the
// previous environment's rows or polls after its head), and the route detail link keeps the
// service, environment and window of the page it starts on. Mocked API.
import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

import { requestRows, rowTraceIds } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { routeAnswers } from "./mock-overview.ts";
import { slower } from "./mock-route-explain.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash: string) => `${origin}${BASE_PATH}/#/${hash}`;
const idOf = (seq: number) => seq.toString(16).padStart(32, "0");
const POLL = { timeout: 10_000 };

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset(0);
  mock.mode = "standalone";
  const info = (name: string) => ({
    name,
    unset: false,
    services: ["orders"],
    lastSeenUnixMs: Date.now(),
  });
  mock.environments = [info("production"), info("staging"), info("idle")];
});

const select = (page: Page, environment: string) =>
  page.getByTestId("environment-select").selectOption(environment);
const errorRows = (page: Page) =>
  page.getByTestId("errors").locator("tbody tr[data-testid=error-row]");

test("Requests: a switch shows only the new environment's rows, and an idle one shows none", async ({
  page,
}) => {
  mock.push(3, {}, "production"); // seq 1..3
  mock.push(2, {}, "staging"); // seq 4..5
  await page.goto(url("requests"));
  await expect(requestRows(page)).toHaveCount(5);

  await select(page, "production");
  await expect(requestRows(page)).toHaveCount(3);
  expect(await rowTraceIds(page)).toEqual([idOf(3), idOf(2), idOf(1)]);

  await select(page, "staging");
  await expect(requestRows(page)).toHaveCount(2);
  expect(await rowTraceIds(page)).toEqual([idOf(5), idOf(4)]);

  await select(page, "idle");
  await expect(requestRows(page)).toHaveCount(0);
  // A poll of the idle environment must not bring the old rows back.
  const polls = () => mock.requests.filter((r) => /^traces\?.*after=/.test(r));
  const before = polls().length;
  await expect.poll(() => polls().length, POLL).toBeGreaterThan(before);
  await expect(requestRows(page)).toHaveCount(0);
  // Every list request after the switch carries the environment.
  expect(mock.requests.filter((r) => /^traces\?/.test(r)).at(-1)).toContain(
    "environment=idle",
  );
});

test("Requests: new rows after a switch come only from the selected environment", async ({
  page,
}) => {
  mock.push(2, {}, "production"); // 1, 2
  mock.push(2, {}, "staging"); // 3, 4
  await page.goto(url("requests?environment=production"));
  await expect(requestRows(page)).toHaveCount(2);
  await select(page, "staging");
  await expect(requestRows(page)).toHaveCount(2);

  mock.push(1, {}, "production"); // 5: not staging's
  mock.push(1, {}, "staging"); // 6
  await expect(requestRows(page)).toHaveCount(3, POLL);
  expect(await rowTraceIds(page)).toEqual([idOf(6), idOf(4), idOf(3)]);
});

test("All Errors: a switch shows only the new environment's rows, and an idle one shows none", async ({
  page,
}) => {
  mock.errors.push(3, "production");
  mock.errors.push(2, "staging");
  await page.goto(url("errors?view=all"));
  await expect(errorRows(page)).toHaveCount(5);

  await select(page, "production");
  await expect(errorRows(page)).toHaveCount(3);
  await select(page, "staging");
  await expect(errorRows(page)).toHaveCount(2);
  await select(page, "idle");
  await expect(errorRows(page)).toHaveCount(0);
  await expect(page.getByText("No errors yet.")).toBeVisible();
  const before = mock.requests.filter((r) => /^errors\?.*after=/.test(r));
  await expect
    .poll(
      () => mock.requests.filter((r) => /^errors\?.*after=/.test(r)).length,
      POLL,
    )
    .toBeGreaterThan(before.length);
  await expect(errorRows(page)).toHaveCount(0);
});

test("Routes: the detail link, and the route-explain request, keep service, environment and window", async ({
  page,
}) => {
  mock.services = ["orders", "billing"];
  const routes = routeAnswers();
  mock.routeStats = routes.stats;
  mock.routeCompare = (q) =>
    routes.compare(Number(q.get("windowMinutes") ?? 15));
  mock.routeExplain = slower;
  await page.goto(
    url("routes?service=orders&environment=staging&windowMinutes=60"),
  );
  const link = page.getByTestId("route-details-link").first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByTestId("breadcrumb")).toBeVisible();
  await expect
    .poll(
      () => mock.requests.some((r) => r.startsWith("routes/explain?")),
      POLL,
    )
    .toBe(true);
  const explain = new URLSearchParams(
    mock.requests.find((r) => r.startsWith("routes/explain?"))?.split("?")[1],
  );
  expect(explain.get("service")).toBe("orders");
  expect(explain.get("environment")).toBe("staging");
  expect(explain.get("windowMinutes")).toBe("60");
});
