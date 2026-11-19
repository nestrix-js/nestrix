import type { Server } from "node:http";
import type { ProfileSummary, TraceResponse } from "@nestrix-js/protocol";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { MockApi } from "./mock-api.ts";
import { degraded } from "./mock-overview.ts";
import { richProfile } from "./mock-rich-profile.ts";
import { BASE_PATH, startServer } from "./serve.ts";

const fixtureUrl = new URL("../../protocol/fixtures/trace.ts", import.meta.url)
  .href;
const { trace } = (await import(fixtureUrl)) as { trace: TraceResponse };

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/${hash}`;
const POLL = { timeout: 10_000 };

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

/** What a selected state may change besides the background colour: this is what the probe reads. */
const look = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    return {
      boxShadow: s.boxShadow,
      fontWeight: s.fontWeight,
      borderColor: s.borderTopColor,
      backgroundColor: s.backgroundColor,
      color: s.color,
    };
  });

/** The colour a token class resolves to, read from a throwaway element. */
const tokenColor = (page: Page, className: string) =>
  page.evaluate((cls) => {
    const el = document.createElement("span");
    el.className = cls;
    document.body.append(el);
    const color = getComputedStyle(el).color;
    el.remove();
    return color;
  }, className);

for (const scheme of ["light", "dark"] as const) {
  test(`error text uses the readable token, not the fill colour (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(url("requests"));
    await expect(page.getByTestId("connection")).toHaveAttribute(
      "data-state",
      "live",
    );
    mock.failing.add("meta");
    const chip = page.getByTestId("connection");
    await expect(chip).toHaveAttribute("data-state", "disconnected", POLL);
    const readable = await tokenColor(page, "text-destructive-text");
    const fill = await tokenColor(page, "text-destructive");
    expect(readable).not.toBe(fill);
    expect((await look(chip)).color).toBe(readable);
    expect((await look(page.getByTestId("connection-banner"))).color).toBe(
      readable,
    );
  });
}

test("selected rows differ from hover and plain rows by more than the background", async ({
  page,
}) => {
  await page.goto(url("routes"));
  const rows = page.getByTestId("route-row");
  await expect(rows.nth(1)).toBeVisible();
  const plain = await look(rows.nth(1));
  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  const selected = await look(rows.nth(0));
  expect(selected.boxShadow).not.toBe(plain.boxShadow);
  expect(selected.boxShadow).not.toBe("none");
  expect(selected.fontWeight).not.toBe(plain.fontWeight);
  // Hover alone (the other row) does not draw the bar.
  await rows.nth(1).hover();
  const hovered = await look(rows.nth(1));
  expect(hovered.boxShadow).toBe(plain.boxShadow);
  expect(hovered.fontWeight).toBe(plain.fontWeight);
});

test("a selected waterfall span has the bar and the weight; hover does not", async ({
  page,
}) => {
  await page.route("**/api/v1/trace?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(trace),
    }),
  );
  await page.goto(url(`traces/${trace.traceId}`));
  const rows = page.getByTestId("span-row");
  await expect(rows).toHaveCount(4);
  const plain = await look(rows.nth(3));
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  const selected = await look(rows.nth(1));
  expect(selected.boxShadow).not.toBe(plain.boxShadow);
  expect(selected.fontWeight).not.toBe(plain.fontWeight);
  await rows.nth(3).hover();
  const hovered = await look(rows.nth(3));
  expect(hovered.boxShadow).toBe(plain.boxShadow);
  expect(hovered.fontWeight).toBe(plain.fontWeight);
});

test("map: the selected Inspect chip has its own border, the selected node a solid ring, the app node is not filled", async ({
  page,
}) => {
  await page.goto(url("map"));
  const chips = page.getByTestId("map-node-button");
  await expect(chips).toHaveCount(5);
  const plain = await look(chips.nth(1));
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
  const selected = await look(chips.nth(1));
  expect(selected.borderColor).not.toBe(plain.borderColor);
  expect(selected.fontWeight).not.toBe(plain.fontWeight);
  const ring = page
    .locator('[data-testid="map-node"][data-selected="true"] rect')
    .first();
  await expect(ring).toHaveCSS("stroke-dasharray", "none");
  await expect(ring).toHaveCSS("stroke-width", "2px");
  await expect(
    page.locator('[data-testid="map-node"] rect.fill-primary'),
  ).toHaveCount(0);
});

test("profiler: the pressed View button reads Viewing and looks different", async ({
  page,
}) => {
  const { flame, topFunctions } = richProfile();
  const make = (n: number): ProfileSummary => ({
    id: n.toString(16).padStart(16, "0"),
    startedAtUnixMs: Date.now() - n * 60_000,
    durationMs: 30_000,
    actualDurationMs: 30_047.5,
    startPauseMs: 41,
    samples: 1000,
    bytes: 117_521,
  });
  mock.profiles = [make(1), make(2)];
  for (const p of mock.profiles)
    mock.profileDetails.set(p.id, { ...p, topFunctions, flame });
  await page.goto(url("profiler"));
  const rows = page.getByTestId("profile-row");
  await expect(rows).toHaveCount(2);
  const button = (i: number) => rows.nth(i).getByRole("button");
  await expect(button(0)).toHaveAttribute("aria-pressed", "true");
  await expect(button(0)).toHaveText("Viewing");
  await expect(button(1)).toHaveText("View");
  const on = await look(button(0));
  const off = await look(button(1));
  expect(on.backgroundColor).not.toBe(off.backgroundColor);
  expect(on.color).not.toBe(off.color);
  await button(1).click();
  await expect(button(1)).toHaveText("Viewing");
  await expect(button(0)).toHaveText("View");
});

test("a failing meta keeps the tabs and the service picker, says when the data is from, and stops offering Pause", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.services = ["orders", "billing"];
  await page.goto(url("requests"));
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(page.getByTestId("connection-banner")).toHaveCount(0);
  mock.failing.add("meta");
  const banner = page.getByTestId("connection-banner");
  await expect(banner).toContainText(
    /Lost connection to the server, showing data from \d\d:\d\d/,
    POLL,
  );
  await expect(page.getByTestId("service-select")).toBeVisible();
  await expect(page.getByTestId("mode")).toBeVisible();
  await expect(
    page.getByTestId("section-menu").getByRole("link", { name: "Logs" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause live" })).toBeDisabled();
  mock.failing.clear();
  await expect(banner).toHaveCount(0, POLL);
  await expect(page.getByRole("button", { name: "Pause live" })).toBeEnabled();
});

test("one style for errors: the Overview and the request timeline use the kit state with Try again", async ({
  page,
}) => {
  mock.overview = (w) => degraded(w);
  mock.failing.add("overview");
  await page.goto(url(""));
  const error = page.getByTestId("overview-error");
  await expect(error).toBeVisible();
  await expect(error.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(error).toContainText("Mock failure");
  mock.failing.clear();
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("overview-error")).toHaveCount(0);

  mock.failing.add("traces/timeline");
  await page.goto(url("requests"));
  await expect(page.getByTestId("timeline-error")).toContainText(
    "Could not load the timeline.",
  );
  await expect(page.getByTestId("timeline-error")).toContainText(
    "Mock failure",
  );
});

test("the Overview shows skeletons while it loads", async ({ page }) => {
  mock.overview = (w) => degraded(w);
  await page.route("**/api/v1/overview?*", () => {
    /* never answers */
  });
  await page.goto(url(""));
  const loading = page.getByTestId("overview-loading");
  await expect(loading.getByTestId("skeleton-kpis")).toBeVisible();
  await expect(loading).not.toContainText("Loading");
});

test("the Overview window is the shared segmented control", async ({
  page,
}) => {
  mock.overview = (w) => degraded(w);
  await page.goto(url(""));
  const group = page.getByRole("group", { name: "Time window" });
  await expect(group.getByRole("button", { name: "15 min" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const on = await look(group.getByRole("button", { name: "15 min" }));
  const off = await look(group.getByRole("button", { name: "60 min" }));
  expect(on.backgroundColor).not.toBe(off.backgroundColor);
});

test("Logs says Reload and picks its range with the segmented control", async ({
  page,
}) => {
  mock.mode = "standalone";
  await page.goto(url("logs"));
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  const group = page.getByRole("group", { name: "Time range" });
  await expect(group.getByRole("button", { name: "1h" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Queries: N+1 candidates is a filter chip in the filter row, not a header action", async ({
  page,
}) => {
  await page.goto(url("queries"));
  const chip = page.getByTestId("nplus-filter");
  await expect(chip).toBeVisible();
  await expect(
    page.getByRole("toolbar", { name: "Filters" }).getByTestId("nplus-filter"),
  ).toHaveCount(1);
  const off = await look(chip);
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  const on = await look(chip);
  expect(on.borderColor).not.toBe(off.borderColor);
});

test("an expired remote capture is neutral, not the red of a failed one", async ({
  page,
}) => {
  mock.mode = "standalone";
  mock.remoteProfiler = true;
  const now = Date.now();
  const row = (n: number, state: "failed" | "expired") => ({
    id: n.toString(16).padStart(16, "0"),
    service: "orders-api",
    instanceId: "7f3c2a91-0000-4000-8000-000000000001",
    version: "1.8.2",
    state,
    requestedAtUnixMs: now - 300_000,
    startedAtUnixMs: null,
    finishedAtUnixMs: null,
    durationMs: 30_000,
    actualDurationMs: null,
    samples: null,
    bytes: null,
    error: state === "failed" ? "busy" : null,
  });
  mock.remoteProfiles = [row(2, "failed"), row(1, "expired")];
  await page.goto(url("profiler"));
  const chips = page.locator(
    '[data-testid="captures-section"] [data-slot="chip"]',
  );
  await expect(chips).toHaveCount(2);
  const failed = chips.filter({ hasText: "Failed" });
  const expired = chips.filter({ hasText: "Expired" });
  expect(await expired.getAttribute("data-tone")).toBe("neutral");
  expect(await failed.getAttribute("data-tone")).not.toBe("neutral");
});
