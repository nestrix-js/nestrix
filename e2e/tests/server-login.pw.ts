// The standalone server's sign-in, submitted as a real HTML form by a real browser. API-level tests
// send `Origin` themselves (or use fetch, which always does), so they missed that browsers send
// `Origin: null` for a form POST under a `no-referrer` policy (issue: every browser sign-in got 403).
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const PASSWORD = "e2e-admin-password-123";
let child: ChildProcess;
let base: string;

test.beforeAll(async () => {
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server-login-app.mjs", import.meta.url))],
    {
      env: { ...process.env, E2E_ADMIN_PASSWORD: PASSWORD },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  base = await new Promise<string>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      const m = /PORT=(\d+)/.exec(chunk.toString());
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    child.once("exit", (code) =>
      reject(new Error(`server exited with ${code}`)),
    );
  });
});

test.afterAll(() => {
  child?.kill();
});

test("signing in through the login form reaches the dashboard", async ({
  page,
}) => {
  await page.goto(`${base}/`);
  await expect(page).toHaveURL(/\/login$/);
  await page.fill('input[type="password"]', PASSWORD);
  await page.press('input[type="password"]', "Enter");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator("body")).not.toContainText(
    "did not come from this server",
  );
  // The session cookie is set and the dashboard (the UI's index page) is served, not the login page.
  const cookies = await page.context().cookies(base);
  expect(
    cookies.some((c) => c.name.startsWith("nestrix_admin_") && c.httpOnly),
  ).toBe(true);
  const index = await page.request.get(`${base}/`, { maxRedirects: 0 });
  expect(index.status()).toBe(200);
  expect(await index.text()).not.toContain('name="password"');
});

test("a wrong password still fails, from the same form", async ({ page }) => {
  await page.goto(`${base}/login`);
  await page.fill('input[type="password"]', "not-the-password-x");
  await page.press('input[type="password"]', "Enter");
  await expect(page.locator("body")).toContainText(/password/i);
  const index = await page.request.get(`${base}/`, { maxRedirects: 0 });
  expect(index.status()).toBe(303);
});
