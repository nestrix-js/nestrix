// Phone layouts: at 390 px no page is wider than the screen, and the header stays compact.
import type { Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";
import type { MockApi } from "./mock-api.ts";
import { DB_TRACE_ID, dbTrace } from "./mock-db-trace.ts";
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

const T0 = dbTrace.spans[0]?.startTimeUnixMs ?? 0;
const TRACE = "0af7651916cd43dd8448eb211c80319c";

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function stubLogs(page: Page) {
  const T = Date.now() - 60_000;
  await page.route("**/api/v1/logs?*", (r) =>
    r.fulfill(
      json({
        capture: "all",
        older: null,
        dropped: { total: 12, rateCap: 10, traceCap: 2, outOfRange: 0 },
        items: [
          {
            id: "l1",
            timeUnixMs: T,
            timeUnixNano: String(T * 1e6),
            severity: 17,
            level: "ERROR",
            context: "Db",
            message: "connect ECONNREFUSED 10.0.3.7:5432",
            service: "orders",
            traceId: TRACE,
            traceExists: true,
            truncated: true,
          },
        ],
      }),
    ),
  );
}

async function stubTrace(page: Page) {
  await page.route("**/api/v1/trace?*", (r) => r.fulfill(json(dbTrace)));
  await page.route("**/api/v1/trace/logs?*", (r) =>
    r.fulfill(
      json({
        traceId: DB_TRACE_ID,
        truncated: false,
        items: [
          {
            timeUnixMs: T0 + 60,
            severity: 13,
            level: "warn",
            context: "OrdersRepository",
            message: "slow query, 150 ms, retrying after a timeout",
          },
        ],
      }),
    ),
  );
}

const STANDALONE = [
  "",
  "requests",
  "errors",
  "routes",
  "route?method=POST&route=%2Forders",
  "classes",
  "map",
  "queries",
  "dependencies",
  "logs",
  "metrics",
  "slos",
  "alerts",
  "settings",
  `traces/${DB_TRACE_ID}`,
];
const EMBEDDED = [
  "",
  "requests",
  "errors",
  "routes",
  "classes",
  "map",
  "queries",
  "dependencies",
  "runtime",
  "profiler",
  `traces/${DB_TRACE_ID}`,
];

for (const [mode, pages] of [
  ["standalone", STANDALONE],
  ["embedded", EMBEDDED],
] as const) {
  for (const hash of pages) {
    test(`${mode} /${hash.split("?")[0] || "overview"} fits a 390 px screen`, async ({
      page,
    }) => {
      if (mode === "standalone") {
        mock.mode = "standalone";
        mock.services = ["orders", "billing"];
        mock.metricsAvailable = true;
      } else {
        mock.runtimeAvailable = true;
        mock.profilerAvailable = true;
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await stubLogs(page);
      await stubTrace(page);
      await page.goto(`${origin}${BASE_PATH}/#/${hash}`);
      await expect(page.getByRole("main")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });
  }
}

test("phone header: Pause live and Sign out are icons with names, in one row", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.services = ["orders", "billing"];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}${BASE_PATH}/#/requests`);
  const pause = page.getByRole("button", { name: "Pause live" });
  const signOut = page.getByRole("button", { name: "Sign out" });
  await expect(pause).toBeVisible();
  await expect(signOut).toBeVisible();
  // Icon-only: the button is as wide as it is tall, give or take the padding.
  expect((await pause.boundingBox())?.width).toBeLessThan(50);
  expect((await signOut.boundingBox())?.width).toBeLessThan(50);
  // Pause, Sign out and the connection state share one row (their centres are within a few px).
  const centres = await Promise.all(
    [pause, signOut, page.getByTestId("connection")].map(async (l) => {
      const box = await l.boundingBox();
      return (box?.y ?? 0) + (box?.height ?? 0) / 2;
    }),
  );
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(6);
  // On a wide screen the words are back.
  await page.setViewportSize({ width: 1280, height: 900 });
  expect((await pause.boundingBox())?.width).toBeGreaterThan(80);
});

test("the header keeps its height when the service select appears", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  mock.mode = "standalone";
  mock.services = ["orders"];
  await page.goto(`${origin}${BASE_PATH}/#/requests`);
  await expect(page.getByTestId("connection")).toBeVisible();
  const one = await page.getByRole("banner").boundingBox();
  mock.services = ["orders", "billing"];
  await page.goto(`${origin}${BASE_PATH}/#/requests`);
  await expect(page.getByTestId("service-select")).toBeVisible();
  const two = await page.getByRole("banner").boundingBox();
  expect(two?.height).toBe(one?.height);
});
