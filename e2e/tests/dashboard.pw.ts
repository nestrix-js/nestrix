// Roadmap, phase 2 acceptance, against real apps (each test boots one as a child process):
//   "works in Express, Fastify and platform-node, with and without a global prefix, with
//   useSecurityHeaders() and with host CORS"        -> the four flows per adapter below
//   "a Playwright test opens a trace and checks the waterfall rows" -> inside every flow
//   "NODE_ENV=production and no auth: unreachable, app starts"       -> production test
//   "host catch-all on Express: reported as shadowed"                -> catch-all test
//   "sample rate 0.1: counts match, UI shows lists are sampled"     -> sampling test
//   "without the startup token cookie: no data; the logged link sets the cookie and it loads"
//                                                                    -> checked in every flow
// The non-loopback, forwarding-header and cross-site rules are packages/nestjs/test's.

import type { Page } from "@playwright/test";
import {
  type Adapter,
  type App,
  type AppOptions,
  expect,
  noAccessControlHeaders,
  send,
  test,
  watch,
} from "./harness.ts";

const NESTRIX_CSP_START = "default-src 'none'; script-src 'self'";

/**
 * The whole path a user takes: no cookie, no data; the logged link; the request list; one trace's
 * waterfall (names and nesting); the error list; the routes view.
 */
async function mainFlow(
  page: Page,
  app: App,
  extra: { securityHeaders?: boolean; cors?: boolean } = {},
): Promise<void> {
  const p = app.prefix;
  const w = await watch(page);

  // Requests to the app's own routes. /out calls this app's /hello twice, over fetch and node:http,
  // so its trace has two client spans and, through traceparent, two server spans under them.
  expect(await send(app, "/hello")).toEqual([200]);
  expect(await send(app, "/users/42")).toEqual([200]);
  expect(await send(app, "/out")).toEqual([200]);
  expect(await send(app, "/boom")).toEqual([500]);

  // Without the startup token cookie the API gives no data.
  const bare = await fetch(`${app.base}/_nestrix/api/v1/traces`);
  expect(bare.status).not.toBe(200);
  expect(await bare.text()).not.toContain("GET /out");

  // The logged link sets the cookie, redirects, and the dashboard loads.
  await page.goto(app.link);
  await expect(page).toHaveURL(/\/_nestrix\/(#.*)?$/);
  const list = page.getByTestId("requests").locator("tbody tr");
  // Four traces: /hello, /users/:id, /out (with the two /hello server spans inside it), /boom.
  await expect(list).toHaveCount(4);
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  const rows = await list.evaluateAll((trs) =>
    trs.map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim()),
    ),
  );
  const byRoute = new Map(rows.map((cells) => [cells[2], cells]));
  expect(byRoute.get(`${p}/hello`)?.[3]).toBe("200");
  expect(byRoute.get(`${p}/boom`)?.[3]).toBe("500");
  expect(byRoute.get(`${p}/boom`)?.[6]).toBe("error");
  expect(byRoute.get(`${p}/out`)?.[5]).toBe("5");
  // The self-call's inner /hello server spans are not roots: no /hello row has more than one span.
  expect(
    rows.filter((cells) => cells[2] === `${p}/hello`).map((c) => c[5]),
  ).toEqual(["1"]);

  // Open the /out trace: five rows, three levels.
  await list
    .filter({ hasText: `${p}/out` })
    .getByRole("link")
    .first()
    .click();
  await expect(page).toHaveURL(/#\/traces\/[0-9a-f]{32}/);
  const waterfall = page.getByTestId("waterfall");
  await expect(waterfall).toBeVisible();
  const span = waterfall.getByTestId("span-row");
  await expect(span).toHaveCount(5);
  const tree = await span.evaluateAll((els) =>
    els.map((el) => ({
      level: Number(el.getAttribute("aria-level")),
      name: el.querySelector('[data-testid="span-name"]')?.textContent?.trim(),
      error: el.getAttribute("data-error"),
    })),
  );
  expect(tree).toEqual([
    { level: 1, name: `GET ${p}/out`, error: null },
    { level: 2, name: "GET", error: null },
    { level: 3, name: `GET ${p}/hello`, error: null },
    { level: 2, name: "GET", error: null },
    { level: 3, name: `GET ${p}/hello`, error: null },
  ]);
  await expect(page.getByTestId("trace-span-count")).toContainText("5");

  // The error list shows the thrown error.
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByText("Errors")
    .click();
  // Grouped is the default view (P9-04): one group for the thrown error.
  await expect(page.getByTestId("error-group-row")).toHaveCount(1);
  await expect(page.getByTestId("group-count")).toHaveText("1");
  // The flat list still shows the error itself.
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByTestId("error-row")).toHaveCount(1);
  await expect(page.getByTestId("error-message")).toHaveText("boom");

  // The routes view shows counts (/hello is hit once directly and twice by /out).
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByText("Routes")
    .click();
  const routeRows = page.getByTestId("route-row");
  await expect(routeRows).toHaveCount(4);
  const counts = await routeRows.evaluateAll((trs) =>
    Object.fromEntries(
      trs.map((tr) => {
        const td = tr.querySelectorAll("td");
        return [td[1]?.textContent?.trim(), td[2]?.textContent?.trim()];
      }),
    ),
  );
  expect(counts).toEqual({
    [`${p}/hello`]: "3",
    [`${p}/users/:id`]: "1",
    [`${p}/out`]: "1",
    [`${p}/boom`]: "1",
  });

  // Every response the browser got from the dashboard carries Nestrix's own headers, whatever the
  // host does, and none carries CORS allow headers.
  const doc = w.responses.find((r) => r.url.endsWith("/_nestrix/"));
  expect(doc?.headers["content-security-policy"]).toContain(NESTRIX_CSP_START);
  expect(doc?.headers["x-frame-options"]).toBe("DENY");
  expect(noAccessControlHeaders(w)).toEqual([]);
  if (extra.securityHeaders || extra.cors) {
    // The host's layer is on for the app's own routes (a JSON route: Fastify's preSerialization CORS hook skips plain strings; the dashboard's responses are checked above).
    const own = await fetch(`${app.base}${p}/users/42`, {
      headers: { origin: "http://example.test" },
    });
    if (extra.securityHeaders)
      expect(own.headers.get("strict-transport-security")).not.toBeNull();
    if (extra.cors)
      expect(own.headers.get("access-control-allow-origin")).not.toBeNull();
  }

  // No CSP violation, console error, page error, failed request or HTTP error, anywhere.
  expect(w.problems).toEqual([]);
}

const adapters: Adapter[] = ["express", "fastify", "node"];
const variants: { name: string; options: Partial<AppOptions> }[] = [
  { name: "main flow", options: {} },
  { name: "with a global prefix", options: { prefix: "api" } },
  { name: "with useSecurityHeaders()", options: { securityHeaders: true } },
  { name: "with host CORS", options: { cors: true } },
];

for (const adapter of adapters) {
  test.describe(adapter, () => {
    for (const { name, options } of variants) {
      test(name, async ({ page, boot }) => {
        const app = await boot({ entry: adapter, ...options });
        await mainFlow(page, app, options);
      });
    }
  });
}

test.describe("express, CommonJS", () => {
  test("main flow", async ({ page, boot }) => {
    const app = await boot({ entry: "express-cjs" });
    await mainFlow(page, app);
  });
});

test.describe("express, once", () => {
  test("sampleRate 0.1: route counts equal the requests sent, and the UI says lists are sampled", async ({
    page,
    boot,
  }) => {
    const app = await boot({ entry: "express", sampleRate: 0.1 });
    const w = await watch(page);
    const sent = 40;
    await send(app, "/hello", sent);
    await page.goto(app.link);
    await expect(page.getByTestId("sampling-notice")).toHaveText(
      "lists are sampled",
    );
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByText("Routes")
      .click();
    const hello = page.getByTestId("route-row").filter({ hasText: "/hello" });
    await expect(hello.locator("td").nth(2)).toHaveText(String(sent));
    // The list holds only the sampled traces (each is kept with probability 0.1).
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByText("Requests")
      .click();
    await expect(page.getByTestId("connection")).toHaveAttribute(
      "data-state",
      "live",
    );
    const listed = await page
      .getByTestId("requests")
      .locator("tbody tr")
      .count();
    expect(listed).toBeLessThan(sent);
    expect(w.problems).toEqual([]);
  });

  test("a host catch-all: the shadowing line is logged after one visit", async ({
    page,
    boot,
  }) => {
    const app = await boot({ entry: "express", catchAll: true });
    // Passive detection: nothing is logged until someone asks.
    expect(app.logs()).not.toContain("is shadowed by a host route");
    const res = await page.goto(app.link);
    expect(await res?.text()).toBe("host-catch-all");
    await expect
      .poll(() => app.logs())
      .toMatch(/Nestrix dashboard: \/_nestrix is shadowed by a host route/);
  });

  test("NODE_ENV=production without auth: the dashboard answers 404 and the app serves its own routes", async ({
    boot,
  }) => {
    const app = await boot({
      entry: "express",
      nodeEnv: "production",
      expectLink: false,
    });
    expect(await send(app, "/hello")).toEqual([200]);
    for (const path of ["/_nestrix", "/_nestrix/", "/_nestrix/api/v1/traces"]) {
      const res = await fetch(`${app.base}${path}`);
      expect(res.status, path).toBe(404);
    }
    expect(app.logs()).not.toMatch(/Nestrix dashboard: http/);
    expect(app.logs()).toMatch(
      /Nestrix dashboard: off, because NODE_ENV is "production"/,
    );
  });
});
