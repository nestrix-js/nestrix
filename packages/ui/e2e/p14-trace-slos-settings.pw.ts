import type { Server } from "node:http";
import type {
  Slo,
  TraceLogsResponse,
  TraceResponse,
} from "@nestrix-js/protocol";
import { expect, type Page, test } from "@playwright/test";

import { watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { DB_TRACE_ID, dbTrace } from "./mock-db-trace.ts";
import { BASE_PATH, startServer } from "./serve.ts";

// Phase 14 (P14-05): the trace view, SLOs and Settings in the kit's style, in both colour
// schemes, plus the shared empty and error states.
let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/${hash}`;
const SHOTS = "test-results";
const SCHEMES = ["dark", "light"] as const;

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

/** The database fixture trace with a service, release, user, an omitted-spans count and log lines. */
const richTrace = (): TraceResponse => ({
  ...dbTrace,
  resource: { "service.name": "orders", "service.version": "2.4.1" },
  droppedSpans: { total: 12, byKind: { db: 9, other: 3 }, byServer: 0 },
  spans: dbTrace.spans.map((s, i) =>
    i === 0
      ? {
          ...s,
          attributes: {
            ...s.attributes,
            "http.request.method": "GET",
            "http.route": "/orders",
            "http.response.status_code": 200,
            "user.id": "u-1042",
          },
        }
      : s,
  ),
});

const LOGS: TraceLogsResponse = {
  traceId: DB_TRACE_ID,
  truncated: false,
  items: [
    {
      timeUnixMs: T0 + 2,
      severity: 9,
      level: "log",
      context: "OrdersController",
      message: "listing orders",
    },
    {
      timeUnixMs: T0 + 60,
      severity: 13,
      level: "warn",
      context: "OrdersRepository",
      message: "slow query, 150 ms",
    },
    {
      timeUnixMs: T0 + 190,
      severity: 17,
      level: "error",
      context: "OrdersService",
      message: "retrying after a timeout",
    },
  ],
};

async function serve(page: Page, trace: TraceResponse, logs = LOGS) {
  await page.route("**/api/v1/trace?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(trace),
    }),
  );
  await page.route("**/api/v1/trace/logs?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(logs),
    }),
  );
}

for (const scheme of SCHEMES) {
  test(`trace view in ${scheme} mode (screenshot)`, async ({ page }) => {
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await serve(page, richTrace());
    await page.goto(url(`traces/${DB_TRACE_ID}`));

    const header = page.getByTestId("trace-header");
    await expect(header).toBeVisible();
    await expect(page.getByTestId("trace-title")).toHaveText("GET /orders");
    await expect(page.getByTestId("trace-status")).toHaveText("200");
    await expect(page.getByTestId("trace-service")).toHaveText("orders");
    await expect(page.getByTestId("trace-release")).toHaveText("2.4.1");
    await expect(page.getByTestId("trace-user")).toHaveText("u-1042");
    await expect(page.getByTestId("trace-omitted-chip")).toHaveText(
      "12 omitted",
    );
    await expect(page.getByTestId("omitted-banner")).toBeVisible();
    await expect(page.getByTestId("omitted-row")).toBeVisible();
    await expect(page.getByTestId("logs-panel")).toContainText("Logs (3)");
    // Nested rows draw one guide per level; the root has none.
    const depths = await page
      .getByTestId("span-row")
      .evaluateAll((els) =>
        els.map((el) => [
          Number(el.getAttribute("data-depth")),
          el.querySelectorAll('[data-testid="nest-guide"]').length,
        ]),
      );
    for (const [depth, guides] of depths) expect(guides).toBe(depth);

    await page.getByTestId("critical-path-toggle").click();
    await page.getByTestId("span-row").nth(2).click();
    await expect(page.getByTestId("span-detail")).toBeVisible();
    await page.screenshot({
      path: `${SHOTS}/p14-trace-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("a trace that is gone shows the empty state, a failure the error state", async ({
  page,
}) => {
  await page.route("**/api/v1/trace?*", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "not_found", message: "Trace not found" },
      }),
    }),
  );
  await page.goto(url(`traces/${"ab".repeat(16)}`));
  await expect(page.getByTestId("trace-evicted")).toContainText(
    "Trace not found",
  );
  await expect(page.getByTestId("trace-error")).toHaveCount(0);

  await page.unroute("**/api/v1/trace?*");
  await page.route("**/api/v1/trace?*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "internal", message: "store unavailable" },
      }),
    }),
  );
  await page.goto(url(`traces/${"cd".repeat(16)}`));
  const error = page.getByTestId("trace-error");
  await expect(error).toContainText("Could not load the trace");
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error.getByRole("button", { name: "Retry" })).toBeVisible();
});

const slo = (over: Partial<Slo> = {}): Slo => ({
  id: "1",
  name: "Checkout availability",
  service: "orders",
  route: "/checkout",
  kind: "availability",
  latencyThresholdMs: null,
  objective: 0.999,
  windowDays: 30,
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0,
  status: {
    totalRequests: 20000,
    goodRequests: 19990,
    badRequests: 10,
    attainment: 0.9995,
    errorBudget: {
      totalRequests: 20,
      remainingRequests: 10,
      remainingFraction: 0.5,
    },
    burnRate: { "1h": 0.6, "6h": 0.4 },
    breached: false,
  },
  ...over,
});

function seedSlos() {
  mock.mode = "standalone";
  mock.services = ["orders", "billing"];
  mock.slos = [
    slo(),
    slo({
      id: "2",
      name: "Billing latency",
      service: "billing",
      route: null,
      kind: "latency",
      latencyThresholdMs: 300,
      objective: 0.99,
      windowDays: 7,
      status: {
        ...slo().status,
        attainment: 0.95,
        errorBudget: {
          totalRequests: 200,
          remainingRequests: -300,
          remainingFraction: -1.5,
        },
        burnRate: { "1h": 14.4, "6h": 5 },
        breached: true,
      },
    }),
    slo({
      id: "3",
      name: "Search availability",
      service: "orders",
      route: "/search",
      status: {
        ...slo().status,
        attainment: 0.9992,
        errorBudget: {
          totalRequests: 20,
          remainingRequests: 3,
          remainingFraction: 0.15,
        },
        burnRate: { "1h": 1.8, "6h": null },
      },
    }),
  ];
}

for (const scheme of SCHEMES) {
  test(`SLOs in ${scheme} mode (screenshot)`, async ({ page }) => {
    const problems = watch(page);
    seedSlos();
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("slos"));
    await expect(page.getByTestId("slo")).toHaveCount(3);
    await expect(
      page.getByTestId("kpi-strip").getByTestId("kpi-value"),
    ).toHaveText(["3", "1", "-150", "14.4x"]);
    await expect(page.getByTestId("kpi-breached")).toBeVisible();
    // The ring and the burn bars say their takeaway to a screen reader.
    await expect(
      page.getByTestId("slo").nth(1).getByTestId("burn-chart").getByRole("img"),
    ).toHaveAttribute("aria-label", /1 h 14\.4x, 6 h 5x/);
    await page.getByRole("button", { name: "New SLO" }).click();
    await expect(page.getByTestId("slo-form")).toBeVisible();
    await page.screenshot({
      path: `${SHOTS}/p14-slos-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("SLOs: empty and error states use the kit", async ({ page }) => {
  mock.mode = "standalone";
  await page.goto(url("slos"));
  await expect(page.getByTestId("slos-empty")).toContainText("No SLOs yet");

  await page.route("**/api/v1/slos*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "internal", message: "history is unavailable" },
      }),
    }),
  );
  await page.goto(url("slos"));
  await page.reload();
  const error = page.getByTestId("slos-error");
  await expect(error).toContainText("Could not load SLOs");
  await expect(error).toContainText("history is unavailable");
});

test("phone width: SLOs, Settings and the trace view do not scroll the page sideways", async ({
  page,
}) => {
  seedSlos();
  await serve(page, richTrace());
  await page.setViewportSize({ width: 390, height: 800 });
  for (const hash of ["slos", "settings", `traces/${DB_TRACE_ID}`]) {
    await page.goto(url(hash));
    await expect(
      page.getByTestId("page-header").or(page.getByTestId("trace-header")),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("slo")
        .or(page.getByTestId("api-tokens"))
        .or(page.getByTestId("waterfall")),
    ).not.toHaveCount(0);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, hash).toBeLessThanOrEqual(0);
  }
});

for (const scheme of SCHEMES) {
  test(`Settings in ${scheme} mode (screenshot)`, async ({ page }) => {
    const problems = watch(page);
    mock.mode = "standalone";
    const now = Date.now();
    mock.tokens = [
      {
        id: "7",
        name: "ci reader",
        prefix: "nxt_Zz9-",
        createdAtUnixMs: now - 3 * 86_400_000,
        lastUsedAtUnixMs: now - 2 * 3_600_000,
        revokedAtUnixMs: null,
      },
      {
        id: "8",
        name: "old laptop",
        prefix: "nxt_Q1ab",
        createdAtUnixMs: now - 40 * 86_400_000,
        lastUsedAtUnixMs: null,
        revokedAtUnixMs: now - 86_400_000,
      },
    ];
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("settings"));
    await expect(page.getByTestId("token")).toHaveCount(2);
    await expect(page.getByTestId("token").nth(1)).toContainText("Revoked");
    await page.getByLabel("Token name").fill("laptop MCP");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByTestId("new-token")).toContainText(
      "not shown again",
    );
    await page.screenshot({
      path: `${SHOTS}/p14-settings-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("Settings: empty and error states use the kit", async ({ page }) => {
  mock.mode = "standalone";
  await page.goto(url("settings"));
  await expect(page.getByTestId("tokens-empty")).toContainText("No tokens yet");

  await page.route("**/api/v1/tokens*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "internal", message: "token store offline" },
      }),
    }),
  );
  await page.reload();
  await expect(page.getByTestId("tokens-error")).toContainText(
    "token store offline",
  );
});
