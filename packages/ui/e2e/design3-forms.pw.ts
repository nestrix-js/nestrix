// Design round 3: forms, popovers and confirmations. Behaviour only; the look is in the
// screenshots of the design audit.
import type { Server } from "node:http";
import type { Slo } from "@nestrix-js/protocol";
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
  mock.services = ["orders"];
});

const slo = (over: Partial<Slo> = {}): Slo => ({
  id: "1",
  name: "Checkout availability",
  service: "orders",
  environment: null,
  route: null,
  kind: "availability",
  latencyThresholdMs: null,
  objective: 0.999,
  windowDays: 30,
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0,
  status: {
    totalRequests: 0,
    goodRequests: 0,
    badRequests: 0,
    attainment: null,
    errorBudget: {
      totalRequests: 0,
      remainingRequests: 0,
      remainingFraction: null,
    },
    burnRate: { "1h": null, "6h": null },
    breached: false,
  },
  ...over,
});

test("a form opens on its first field; Esc closes it and returns to the button that opened it", async ({
  page,
}) => {
  await page.goto(url("slos"));
  const open = page.getByRole("button", { name: "New SLO" });
  await open.click();
  await expect(page.getByLabel("Name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("slo-form")).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("a validation message sits under its field, is announced, marks the field invalid and takes focus", async ({
  page,
}) => {
  await page.goto(url("slos"));
  await page.getByRole("button", { name: "New SLO" }).click();
  const form = page.getByTestId("slo-form");
  await form.getByRole("button", { name: "Create SLO" }).click();

  const name = form.getByLabel("Name");
  const message = form.getByTestId("slo-name-error");
  await expect(message).toHaveText("Give the SLO a name.");
  await expect(message).toHaveAttribute("role", "alert");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAttribute("aria-describedby", /slo-name-error/);
  await expect(name).toBeFocused();
  // The message is below the control it belongs to.
  const nameBox = await name.boundingBox();
  const messageBox = await message.boundingBox();
  expect(
    (messageBox?.y ?? 0) >= (nameBox?.y ?? 0) + (nameBox?.height ?? 0) - 1,
  ).toBe(true);
  expect(mock.sloWrites).toEqual([]);

  // Typing clears it; the next problem is reported on its own field.
  await name.fill("Orders");
  await expect(message).toHaveCount(0);
  await form.getByLabel("Objective (%)").fill("100");
  await form.getByRole("button", { name: "Create SLO" }).click();
  await expect(form.getByTestId("slo-objective-error")).toContainText(
    "above 0 and below 100",
  );
  await expect(form.getByLabel("Objective (%)")).toBeFocused();
});

test("Enter in a field submits the form", async ({ page }) => {
  await page.goto(url("slos"));
  await page.getByRole("button", { name: "New SLO" }).click();
  await page.getByLabel("Name").fill("Via Enter");
  await page.getByLabel("Name").press("Enter");
  await expect(page.getByTestId("slo")).toContainText("Via Enter");
  expect(mock.sloWrites).toHaveLength(1);
});

test("required fields are marked without changing their accessible names", async ({
  page,
}) => {
  await page.goto(url("alerts"));
  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByTestId("alert-form");
  await expect(form.getByLabel("Name", { exact: true })).toHaveAttribute(
    "aria-required",
    "true",
  );
  await expect(form.getByLabel(/^Route \(optional/)).not.toHaveAttribute(
    "aria-required",
    "true",
  );
  await expect(form).toContainText("* required");
});

test("an alert rule's webhook problem is shown under the webhook field", async ({
  page,
}) => {
  await page.goto(url("alerts"));
  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByTestId("alert-form");
  await form.getByLabel("Name", { exact: true }).fill("x");
  await form.getByLabel("Webhook URL").fill("ftp://nope.example/h");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(form.getByTestId("alert-webhook-error")).toContainText(
    "http or https",
  );
  await expect(form.getByLabel("Webhook URL")).toBeFocused();
  await expect(form.getByLabel("Webhook URL")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("a burn-rate rule without an SLO marks the SLO picker", async ({
  page,
}) => {
  mock.slos = [slo()];
  await page.goto(url("alerts"));
  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByTestId("alert-form");
  await form.getByLabel("Name", { exact: true }).fill("Burn");
  await form.getByLabel("Metric").selectOption("slo_burn_rate");
  await form.getByLabel("Webhook URL").fill("https://hooks.example.com/x");
  await form.getByRole("button", { name: "Create rule" }).click();
  await expect(form.getByTestId("alert-slo-error")).toHaveText(
    "Choose an SLO.",
  );
  await expect(form.getByLabel("SLO", { exact: true })).toBeFocused();
});

test("a destructive action asks first: focus on Keep, Esc backs out to the trigger, the trigger names its target", async ({
  page,
}) => {
  mock.slos = [slo()];
  await page.goto(url("slos"));
  const card = page.getByTestId("slo");
  const trigger = card.getByRole("button", {
    name: "Delete Checkout availability",
  });
  await trigger.click();
  await expect(
    card.getByRole("group", { name: "Delete Checkout availability?" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Keep" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    card.getByRole("button", { name: "Confirm delete" }),
  ).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(mock.sloWrites).toEqual([]);

  await trigger.click();
  await card.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByTestId("slo")).toHaveCount(0);
});

test("revoking a token says what follows and the new token is focused, selected", async ({
  page,
}) => {
  mock.tokens = [
    {
      id: "7",
      name: "ci reader",
      prefix: "nxt_Zz9-",
      createdAtUnixMs: Date.now(),
      lastUsedAtUnixMs: null,
      revokedAtUnixMs: null,
    },
  ];
  await page.goto(url("settings"));
  await page.getByRole("button", { name: "Revoke ci reader" }).click();
  await expect(page.getByTestId("token")).toContainText("lose access at once");
  await page.getByRole("button", { name: "Keep" }).click();

  await page.getByLabel("Token name").fill("laptop");
  await page.getByLabel("Token name").press("Enter");
  await expect(page.getByTestId("new-token-secret")).toBeFocused();
});

for (const width of [390, 1440]) {
  test(`filter popovers stay inside the viewport at ${width} px, mark the selection and close on choosing`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url("requests?method=POST"));
    for (const name of ["Route filter", "Method filter", "Status filter"]) {
      await page.getByRole("button", { name }).click();
      const popup = page.locator('[data-slot="popover-content"]');
      await expect(popup).toBeVisible();
      const box = await popup.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
    }
    // The selected option is marked and has a visible state, not only a tick.
    await page.getByRole("button", { name: "Method filter" }).click();
    await expect(page.getByRole("option", { name: "POST" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("option", { name: "GET" }).click();
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
    await expect(page).toHaveURL(/method=GET/);
  });
}

test("Enter in a filter's search takes the first match", async ({ page }) => {
  await page.goto(url("requests"));
  await page.getByRole("button", { name: "Method filter" }).click();
  await page.getByLabel("Search Method").fill("pa");
  await page.getByLabel("Search Method").press("Enter");
  await expect(page).toHaveURL(/method=PATCH/);
});

test("the saved views menu says why Save is off, and fits a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("requests"));
  await page.getByTestId("saved-filters-trigger").click();
  await expect(page.getByTestId("saved-filter-hint")).toBeVisible();
  await expect(page.getByTestId("saved-filter-save")).toBeDisabled();
  const box = await page.locator('[data-slot="popover-content"]').boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
});

test("a regressed group's state is not repeated by a second Regressed chip, and its actions say what they do", async ({
  page,
}) => {
  const now = Date.now();
  mock.errorGroups = (windowMinutes: number) => ({
    windowMinutes,
    bucketMs: 60_000,
    fromUnixMs: now - windowMinutes * 60_000,
    toUnixMs: now,
    ignoredCount: 0,
    history: { fromUnixMs: now - 7 * 86_400_000, toUnixMs: now },
    groups: [
      {
        key: "g1",
        errorType: "RegressedError",
        pattern: "RegressedError number <n>",
        route: "GET /r",
        count: 7,
        firstSeenUnixMs: now - 300_000,
        lastSeenUnixMs: now - 20_000,
        series: Array.from({ length: 15 }, (_, i) => (i === 14 ? 7 : 0)),
        services: ["orders"],
        exampleTraceId: "0".repeat(31) + "1",
        recent: [],
        state: "regressed",
        firstEverUnixMs: now - 3 * 86_400_000,
        lastEverUnixMs: now - 20_000,
        triage: { state: "regressed", resolvedInRelease: "1.0.0" },
      },
    ],
  });
  await page.goto(url("errors"));
  const row = page.getByTestId("error-group-row").first();
  await expect(row.getByTestId("group-triage")).toHaveCount(0);
  await row.getByRole("button").first().click();
  const actions = page.getByTestId("group-triage-actions");
  await expect(actions.getByTestId("triage-resolve")).toHaveAttribute(
    "title",
    /fixed/,
  );
  await expect(actions.getByTestId("triage-ignore")).toHaveAttribute(
    "title",
    /Hide/,
  );
  await expect(
    actions.getByRole("button", { name: "Resolve RegressedError" }),
  ).toBeVisible();
});

test("a profiler capture button names its instance", async ({ page }) => {
  mock.remoteProfiler = true;
  mock.addInstance("7f3c2a91-0000-4000-8000-000000000001", {
    service: "orders-api",
    version: "1.0.0",
    host: "h",
    pid: 1,
    lastSeenUnixMs: Date.now() - 3000,
  });
  await page.goto(url("profiler"));
  await expect(
    page.getByRole("button", { name: "Capture 7f3c2a91" }),
  ).toBeVisible();
});
