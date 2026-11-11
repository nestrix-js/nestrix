import type { Server } from "node:http";
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

test("the Profiler tab is hidden when meta says the profiler is unavailable", async ({
  page,
}) => {
  mock.profilerAvailable = false;
  await page.goto(url());
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(page.getByRole("link", { name: "Profiler" })).toHaveCount(0);
  await page.goto(url("profiler"));
  await expect(page.getByTestId("profiler-unavailable")).toBeVisible();
  expect(mock.requests.some((r) => r.startsWith("profiles"))).toBe(false);
});

test("the standalone server shows no Profiler tab", async ({ page }) => {
  mock.mode = "standalone";
  await page.goto(url());
  await expect(page.getByRole("link", { name: "SLOs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Profiler" })).toHaveCount(0);
});

test("starts a capture with a same-origin JSON fetch, shows progress, then the capture, its table and flame graph, and a download link", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await page.getByRole("link", { name: "Profiler" }).click();
  await expect(page).toHaveURL(/#\/profiler/);
  await expect(page.getByTestId("profiles-empty")).toBeVisible();
  // No capture yet in this process: the static note.
  await expect(page.getByTestId("start-pause-warning")).toContainText(
    "10 ms per MB",
  );
  await expect(page.getByTestId("profiler-caveats")).toContainText(
    "main thread only",
  );
  await expect(page.getByTestId("profiler-caveats")).toContainText(
    "source maps are not applied",
  );
  await expect(page.getByTestId("profiler-caveats")).toContainText("inlined");

  await page.getByLabel("Duration").selectOption("10");
  await page.getByRole("button", { name: "Start capture" }).click();
  await expect(page.getByTestId("capture-running")).toBeVisible();
  await expect(page.getByTestId("capture-running")).toContainText("41 ms");
  await expect(
    page.getByRole("button", { name: "Start capture" }),
  ).toBeDisabled();
  expect(mock.profileStarts).toEqual([
    {
      origin,
      secFetchSite: "same-origin",
      contentType: "application/json",
      body: { durationSeconds: 10 },
    },
  ]);
  // Now the measured pause of the previous capture.
  await expect(page.getByTestId("start-pause-warning")).toContainText("41 ms");

  mock.finishCapture();
  await expect(page.getByTestId("profile-row")).toHaveCount(1);
  await expect(page.getByTestId("capture-running")).toHaveCount(0);
  await expect(page.getByTestId("profile-row")).toContainText("118 KB");

  const top = page.getByTestId("top-functions").locator("tbody tr");
  await expect(top.first()).toContainText("hotRouteWork");
  await expect(top.first()).toContainText("dist/hot.js:18");
  await expect(top.first()).toContainText("83.0%");

  const graph = page.getByTestId("flame-graph");
  await expect(graph).toBeVisible();
  const hot = graph.locator(
    '[data-testid="flame-bar"][data-name="hotRouteWork"]',
  );
  await expect(hot).toHaveCount(1);
  // Positions are attributes (CSP), as fractions of the width.
  expect(await hot.getAttribute("width")).toBe("83.0000%");
  // Zoom into the controller frame, then reset.
  await graph.locator('[data-testid="flame-bar"][data-name="cpu"]').click();
  expect(await hot.getAttribute("width")).not.toBe("83.0000%");
  await page.getByRole("button", { name: "Reset zoom" }).click();
  expect(await hot.getAttribute("width")).toBe("83.0000%");

  const link = page.getByTestId("profile-download");
  const href = await link.getAttribute("href");
  expect(href).toMatch(
    new RegExp(`${BASE_PATH}/api/v1/profiles/0{15}1/download$`),
  );
  expect(await link.getAttribute("download")).not.toBeNull();
  const file = await page.request.get(href as string);
  expect(file.headers()["content-disposition"]).toMatch(
    /^attachment; filename=".+\.cpuprofile"$/,
  );

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("a 403 on start explains that starting a capture needs HTTPS or localhost", async ({
  page,
}) => {
  await page.goto(url("profiler"));
  await expect(page.getByTestId("profiles-empty")).toBeVisible();
  mock.profileStartRefusal = {
    status: 403,
    body: { error: { code: "forbidden", message: "Refused" } },
  };
  await page.getByRole("button", { name: "Start capture" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("needs HTTPS or localhost");
  await expect(alert).not.toContainText("Refused");
});

test("a 429 on start says when a capture is available again", async ({
  page,
}) => {
  await page.goto(url("profiler"));
  await expect(page.getByTestId("profiles-empty")).toBeVisible();
  mock.profileStartRefusal = {
    status: 429,
    body: {
      error: { code: "too_many_requests", message: "Wait" },
      retryAfterSeconds: 7,
    },
    headers: { "Retry-After": "7" },
  };
  await page.getByRole("button", { name: "Start capture" }).click();
  await expect(page.getByRole("alert")).toContainText("Available again in 7 s");
});

test("a refused start shows the server's message", async ({ page }) => {
  await page.goto(url("profiler"));
  await expect(page.getByTestId("profiles-empty")).toBeVisible();
  mock.profileRunning = {
    id: "00000000000000aa",
    startedAtUnixMs: Date.now(),
    durationMs: 30_000,
    endsAtUnixMs: Date.now() + 30_000,
    startPauseMs: 40,
  };
  // The page has not polled yet, so its button is still enabled: the server answers 409.
  await page.getByRole("button", { name: "Start capture" }).click();
  await expect(page.getByRole("alert")).toContainText("A capture is running");
});
