// Issue #17: the standalone Logs page (filters, cursor paging, truncation and drop indicators,
// trace links), with mocked API answers.
import type { Server } from "node:http";
import type { LogSearchResponse } from "@nestrix-js/protocol";
import { expect, type Page, test } from "@playwright/test";

import { recordViolations, violations } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const GHOST = "1af7651916cd43dd8448eb211c80319c";
const T = 1_794_400_000_000;

const PAGE1: LogSearchResponse = {
  capture: "all",
  older: "lcursor1",
  dropped: { total: 12, rateCap: 10, traceCap: 2, outOfRange: 0 },
  items: [
    {
      id: "l1",
      timeUnixMs: T + 3000,
      timeUnixNano: String((T + 3000) * 1_000_000),
      severity: 17,
      level: "ERROR",
      context: "Db",
      message: "connect ECONNREFUSED <img src=x onerror=alert(1)>",
      service: "orders",
      traceId: TRACE,
      traceExists: true,
      truncated: false,
    },
    {
      id: "l2",
      timeUnixMs: T + 2000,
      timeUnixNano: String((T + 2000) * 1_000_000),
      severity: 9,
      level: "INFO",
      message: "worker started",
      service: "orders",
      truncated: true,
    },
    {
      id: "l3",
      timeUnixMs: T + 1000,
      timeUnixNano: String((T + 1000) * 1_000_000),
      severity: 13,
      level: "WARN",
      message: "expired trace",
      service: "billing",
      traceId: GHOST,
      traceExists: false,
      truncated: false,
    },
  ],
};
const PAGE2: LogSearchResponse = {
  ...PAGE1,
  older: null,
  items: [
    {
      id: "l4",
      timeUnixMs: T,
      timeUnixNano: String(T * 1_000_000),
      severity: 5,
      level: "DEBUG",
      message: "older line",
      service: "orders",
      truncated: false,
    },
  ],
};

async function open(
  page: Page,
  answer: (url: URL) => LogSearchResponse | number,
) {
  mock.mode = "standalone";
  const seen: URL[] = [];
  await recordViolations(page);
  await page.route("**/api/v1/logs?*", (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    const out = answer(url);
    return typeof out === "number"
      ? route.fulfill({
          status: out,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "internal", message: "boom" },
          }),
        })
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(out),
        });
  });
  await page.goto(`${origin}${BASE_PATH}/#/logs`);
  return seen;
}

test("lists lines with level colour, flags, drops and trace links; pages older lines", async ({
  page,
}) => {
  const seen = await open(page, (u) =>
    u.searchParams.get("before") === "lcursor1" ? PAGE2 : PAGE1,
  );
  const rows = page.getByTestId("log-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.getByTestId("log-message")).toHaveText([
    "connect ECONNREFUSED <img src=x onerror=alert(1)>",
    "worker started",
    "expired trace",
  ]);
  expect(
    await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-tone")),
    ),
  ).toEqual(["error", "info", "warn"]);
  await expect(rows.nth(0).getByTestId("log-level")).toHaveClass(
    /text-destructive/,
  );
  await expect(page.getByTestId("logs-capture")).toHaveText(
    "storing all log lines",
  );
  await expect(page.getByTestId("logs-dropped")).toHaveText(
    "12 lines dropped (10 over the per-minute budget, 2 over the per-trace maximum)",
  );
  // Truncation only on the second line; a trace link only where the trace is stored.
  await expect(page.getByTestId("log-truncated")).toHaveCount(1);
  await expect(rows.nth(1).getByTestId("log-truncated")).toBeVisible();
  await expect(page.getByTestId("log-trace-link")).toHaveCount(1);
  await expect(page.getByTestId("log-trace-missing")).toHaveCount(1);
  await expect(rows.nth(0).getByTestId("log-trace-link")).toHaveAttribute(
    "href",
    new RegExp(`#/traces/${TRACE}$`),
  );

  await page.getByTestId("logs-older").click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3).getByTestId("log-message")).toHaveText("older line");
  await expect(page.getByTestId("logs-older")).toHaveCount(0);
  expect(seen.at(-1)?.searchParams.get("before")).toBe("lcursor1");
  expect(await violations(page)).toEqual([]);

  await rows.nth(0).getByTestId("log-trace-link").click();
  await expect(page).toHaveURL(new RegExp(`#/traces/${TRACE}$`));
});

test("sends the filters to the API", async ({ page }) => {
  const seen = await open(page, () => PAGE2);
  await expect(page.getByTestId("log-row")).toHaveCount(1);
  await page.getByTestId("logs-text").fill("refused");
  await page.getByTestId("logs-match").check();
  await page.getByTestId("logs-severity").selectOption("warn");
  await page
    .getByTestId("logs-window")
    .getByRole("button", { name: "7d", exact: true })
    .click();
  await page.getByTestId("logs-trace").fill(TRACE);
  await page.getByTestId("logs-search").click();
  await expect
    .poll(() => seen.at(-1)?.searchParams.get("text"))
    .toBe("refused");
  const q = seen.at(-1)?.searchParams;
  expect(q?.get("match")).toBe("substring");
  expect(q?.get("severity")).toBe("warn");
  expect(q?.get("traceId")).toBe(TRACE);
  expect(Number(q?.get("toUnixMs")) - Number(q?.get("fromUnixMs"))).toBe(
    7 * 86_400_000,
  );
  expect(q?.get("before")).toBeNull();
});

test("a malformed trace id disables the search", async ({ page }) => {
  await open(page, () => PAGE2);
  await page.getByTestId("logs-trace").fill("not-a-trace");
  await expect(page.getByTestId("logs-search")).toBeDisabled();
});

test("explains an empty result by the capture mode, and shows errors", async ({
  page,
}) => {
  await open(page, () => ({
    ...PAGE2,
    items: [],
    older: null,
    capture: "trace",
  }));
  await expect(page.getByTestId("logs-empty")).toContainText(
    "NESTRIX_LOGS=all",
  );
  await expect(page.getByTestId("logs-capture")).toHaveText(
    "storing lines with a trace id only",
  );
  await expect(page.getByTestId("logs-dropped")).toHaveCount(1);
});

test("a failing API shows the error state", async ({ page }) => {
  await open(page, () => 500);
  await expect(page.getByTestId("error-state")).toBeVisible();
});

test("the Logs tab is in the standalone menu and absent in embedded mode", async ({
  page,
}) => {
  await open(page, () => PAGE2);
  await expect(
    page.getByTestId("section-menu").getByRole("link", { name: "Logs" }),
  ).toBeVisible();
  mock.mode = "embedded";
  await page.goto(`${origin}${BASE_PATH}/#/requests`);
  await expect(page.getByTestId("section-menu")).toBeVisible();
  await expect(
    page.getByTestId("section-menu").getByRole("link", { name: "Logs" }),
  ).toHaveCount(0);
  await page.goto(`${origin}${BASE_PATH}/#/logs`);
  await expect(page.getByTestId("logs-page")).toContainText(
    "needs the standalone server",
  );
});
