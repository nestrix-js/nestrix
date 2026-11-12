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

test("the Settings page and its tab are hidden in an embedded dashboard", async ({
  page,
}) => {
  await page.goto(url());
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "live",
  );
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.goto(url("settings"));
  await expect(page.getByTestId("settings-unavailable")).toBeVisible();
  expect(mock.requests.some((r) => r.startsWith("tokens"))).toBe(false);
});

test("creates a token, shows it once with a copy button, and lists it without the secret", async ({
  page,
  context,
  browserName,
}) => {
  mock.mode = "standalone";
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
  }
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(url());
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("tokens-empty")).toBeVisible();

  const create = page.getByRole("button", { name: "Create token" });
  await expect(create).toBeDisabled();
  await page.getByLabel("Token name").fill("  laptop MCP ");
  await create.click();

  const shown = page.getByTestId("new-token");
  await expect(shown).toContainText('Token "laptop MCP" created');
  const secret = `nxt_AAAA${"b".repeat(39)}`;
  await expect(page.getByTestId("new-token-secret")).toHaveValue(secret);
  expect(mock.tokenWrites).toEqual([
    { method: "POST", id: null, body: { name: "laptop MCP" } },
  ]);

  await shown.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByTestId("copy-state")).toBeVisible();
  if (browserName === "chromium") {
    await expect(page.getByTestId("copy-state")).toHaveText(
      "Copied to the clipboard.",
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      secret,
    );
  }

  const rows = page.getByTestId("token");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("laptop MCP");
  await expect(rows.first()).toContainText("nxt_AAAA…");
  await expect(rows.first().getByTestId("last-used")).toHaveText("never");

  // Once dismissed, the secret is gone from the page.
  await shown.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("new-token")).toHaveCount(0);
  expect(await page.content()).not.toContain("b".repeat(39));

  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test("revoking needs a confirmation and sends a DELETE", async ({ page }) => {
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
  ];
  await page.goto(url("settings"));
  const row = page.getByTestId("token");
  await expect(row).toContainText("ci reader");
  await expect(row).toContainText("nxt_Zz9-…");
  await expect(row.getByTestId("last-used")).toHaveText("2 hours ago");

  await row.getByRole("button", { name: "Revoke" }).click();
  expect(mock.tokenWrites).toEqual([]);
  await row.getByRole("button", { name: "Keep" }).click();
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(row).toContainText("Revoked");
  await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  expect(mock.tokenWrites).toEqual([
    { method: "DELETE", id: "7", body: undefined },
  ]);
});
