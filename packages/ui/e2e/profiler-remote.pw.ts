import type { Server } from "node:http";
import { expect, test } from "@playwright/test";

import { recordViolations, violations, watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/${hash}`;
const INSTANCE = "3f2a9c1e-77aa-4b1b-9d2e-000000000001";

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
  mock.mode = "standalone";
  mock.remoteProfiler = true;
});

test("the nav shows Profiler between Dependencies and SLOs on a server with remote profiling", async ({
  page,
}) => {
  await page.goto(url());
  const links = page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link");
  await expect(links.filter({ hasText: "Profiler" })).toHaveCount(1);
  const labels = await links.allTextContents();
  expect(labels.indexOf("Profiler")).toBe(labels.indexOf("Dependencies") + 1);
  expect(labels.indexOf("SLOs")).toBe(labels.indexOf("Profiler") + 1);
});

test("no instance: the empty state shows how to opt in and the pause warning", async ({
  page,
}) => {
  await page.goto(url("profiler"));
  const empty = page.getByTestId("instances-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("export: {");
  await expect(empty).toContainText("profiler: true");
  await expect(empty).toContainText("otlp: { endpoint, headers }");
  await expect(page.getByTestId("start-pause-warning")).toContainText(
    "pauses the application",
  );
  await expect(page.getByTestId("profiles-empty")).toBeVisible();
  await expect(page.getByTestId("instances")).toHaveCount(0);
});

test("a capture goes pending, running, done, and its detail renders", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  mock.addInstance(INSTANCE);
  await page.goto(url("profiler"));

  const row = page.getByTestId("instance-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("demo-service");
  await expect(row).toContainText("3f2a9c1e");
  await expect(row).not.toContainText("3f2a9c1e-77aa");
  await expect(row.getByTitle(INSTANCE)).toBeVisible();
  await expect(row).toContainText("1.4.2");
  await expect(row).toContainText("web-1");
  await expect(row).toContainText("4242");
  await expect(row).toContainText("12 seconds ago");
  const capture = row.getByRole("button", { name: "Capture" });
  await expect(capture).toBeEnabled();

  await page.getByLabel("Duration").selectOption("15");
  await capture.click();
  expect(mock.remoteStarts).toEqual([
    {
      origin,
      secFetchSite: "same-origin",
      contentType: "application/json",
      body: {
        service: "demo-service",
        instanceId: INSTANCE,
        durationSeconds: 15,
      },
    },
  ]);
  await expect(page.getByTestId("instance-status")).toContainText(
    "Waiting for the instance (checks in every 15 s)",
  );
  await expect(capture).toBeDisabled();
  await expect(page.getByTestId("remote-profile-row")).toHaveAttribute(
    "data-state",
    "pending",
  );

  mock.advanceRemote("0000000000000001", "running");
  await expect(page.getByTestId("instance-status")).toContainText(
    /Capturing… 1[45] s left/,
  );
  await expect(capture).toBeDisabled();
  await expect(page.getByTestId("remote-profile-row")).toHaveAttribute(
    "data-state",
    "running",
  );

  mock.advanceRemote("0000000000000001", "done");
  await expect(page.getByTestId("instance-status")).toHaveCount(0);
  await expect(capture).toBeEnabled();
  const history = page.getByTestId("remote-profile-row");
  await expect(history).toHaveAttribute("data-state", "done");
  await expect(history).toContainText("Done");
  await expect(history).toContainText("15 seconds");
  await expect(history).toContainText("118 KB");

  // The newest finished capture opens by itself: the shared flame graph and table.
  const top = page.getByTestId("top-functions").locator("tbody tr");
  await expect(top.first()).toContainText("hotRouteWork");
  await expect(top.first()).toContainText("83.0%");
  const graph = page.getByTestId("flame-graph");
  const hot = graph.locator(
    '[data-testid="flame-bar"][data-name="hotRouteWork"]',
  );
  expect(await hot.getAttribute("width")).toBe("83.0000%");
  await graph.locator('[data-testid="flame-bar"][data-name="cpu"]').click();
  expect(await hot.getAttribute("width")).not.toBe("83.0000%");

  const link = page.getByTestId("profile-download");
  const href = await link.getAttribute("href");
  expect(href).toMatch(
    new RegExp(`${BASE_PATH}/api/v1/remote-profiles/0{15}1/download$`),
  );
  const file = await page.request.get(href as string);
  expect(file.headers()["content-disposition"]).toMatch(
    /^attachment; filename=".+\.cpuprofile"$/,
  );

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("a failed capture shows its reason and frees the instance", async ({
  page,
}) => {
  mock.addInstance(INSTANCE);
  await page.goto(url("profiler"));
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByTestId("instance-status")).toBeVisible();
  mock.advanceRemote("0000000000000001", "failed", "busy");
  const history = page.getByTestId("remote-profile-row");
  await expect(history).toHaveAttribute("data-state", "failed");
  await expect(history).toContainText("Failed");
  await expect(history).toContainText("busy");
  await expect(page.getByRole("button", { name: "Capture" })).toBeEnabled();
  // Nothing to view or download for a capture without a profile.
  await expect(page.getByTestId("profile-download")).toHaveCount(0);
  await expect(page.getByTestId("profile-view")).toHaveCount(0);
});

test("a 409 is explained inline and the row shows the capture in progress", async ({
  page,
}) => {
  mock.addInstance(INSTANCE);
  await page.goto(url("profiler"));
  await expect(page.getByTestId("instance-row")).toHaveCount(1);
  // Another admin ordered a capture after the page last polled.
  const other = mock.instances.find((i) => i.instanceId === INSTANCE);
  if (!other) throw new Error("fixture");
  other.capture = {
    id: "00000000000000aa",
    service: "demo-service",
    instanceId: INSTANCE,
    version: "1.4.2",
    state: "running",
    requestedAtUnixMs: Date.now(),
    startedAtUnixMs: Date.now(),
    finishedAtUnixMs: null,
    durationMs: 30_000,
    actualDurationMs: null,
    samples: null,
    bytes: null,
    error: null,
  };
  const row = page.locator(`[data-instance="${INSTANCE}"]`);
  await row.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "already pending or running for instance 3f2a9c1e",
  );
  await expect(row.getByTestId("instance-status")).toContainText("Capturing");
  await expect(row.getByRole("button", { name: "Capture" })).toBeDisabled();
});

test("a 404 says the instance is gone", async ({ page }) => {
  mock.addInstance(INSTANCE);
  await page.goto(url("profiler"));
  await expect(page.getByTestId("instance-row")).toHaveCount(1);
  mock.remoteStartRefusal = {
    status: 404,
    body: { error: { code: "not_found", message: "No such instance" } },
  };
  await page.getByRole("button", { name: "Capture" }).click();
  await expect(page.getByRole("alert")).toContainText("has not checked in");
});

test("a 429 counts down the cool-down", async ({ page }) => {
  mock.addInstance(INSTANCE);
  await page.goto(url("profiler"));
  await expect(page.getByTestId("instance-row")).toHaveCount(1);
  mock.remoteStartRefusal = {
    status: 429,
    body: {
      error: { code: "too_many_requests", message: "Wait" },
      retryAfterSeconds: 4,
    },
    headers: { "Retry-After": "4" },
  };
  await page.getByRole("button", { name: "Capture" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(/available again in [1-4] s/);
  await expect(alert).toContainText("can be captured again now", {
    timeout: 8000,
  });
});

test("a 403 explains that starting a capture needs HTTPS or localhost", async ({
  page,
}) => {
  mock.addInstance(INSTANCE);
  await page.goto(url("profiler"));
  await expect(page.getByTestId("instance-row")).toHaveCount(1);
  mock.remoteStartRefusal = {
    status: 403,
    body: { error: { code: "forbidden", message: "Refused" } },
  };
  await page.getByRole("button", { name: "Capture" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("needs HTTPS or localhost");
  await expect(alert).not.toContainText("Refused");
});
