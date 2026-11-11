import type { Server } from "node:http";
import { expect, test } from "@playwright/test";
import {
  recordViolations,
  requestRows,
  rowTraceIds,
  violations,
  watch,
} from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { BASE_PATH, CSP, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.beforeEach(() => {
  mock.reset();
});
test.afterAll(() => {
  server.close();
});

test("negative control: the harness flags inline script and style under the same CSP", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(`${origin}${BASE_PATH}/__control__`);
  await page.waitForLoadState("load");
  const found = await violations(page);
  expect(found.some((v) => v.startsWith("script-src"))).toBe(true);
  expect(found.some((v) => v.startsWith("style-src"))).toBe(true);
  expect(
    await page.evaluate(
      () => (window as unknown as { inlineRan?: boolean }).inlineRan,
    ),
  ).toBeUndefined();
  expect(problems.some((p) => p.startsWith("console.error"))).toBe(true);
});

for (const entry of [`${BASE_PATH}/`, BASE_PATH]) {
  test(`renders with no CSP violation and no failed request at ${entry}`, async ({
    page,
  }) => {
    const problems = watch(page);
    await recordViolations(page);
    const response = await page.goto(`${origin}${entry}`);

    // The headers the harness sends are the contract; assert them as the browser saw them.
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toBe(CSP);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(
      Object.keys(headers).filter((h) => h.startsWith("access-control-")),
    ).toEqual([]);

    // Templating: base href and the config block were filled in; the API base resolved
    // against the base href (the mock answers only under BASE_PATH).
    await expect(page.locator("base")).toHaveAttribute("href", `${BASE_PATH}/`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "demo-service",
    );
    await expect(requestRows(page)).toHaveCount(50);
    await expect(page.getByTestId("connection")).toHaveAttribute(
      "data-state",
      "live",
    );

    // Portals: popovers and hover cards position with style properties, which the CSP
    // allows through the CSSOM; opening them must not raise a violation.
    await page.getByRole("button", { name: "Status filter" }).click();
    await expect(page.getByRole("option", { name: "error" })).toBeVisible();
    await page.keyboard.press("Escape");
    await requestRows(page).first().locator("time").hover();
    await expect(page.getByText("UTC", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View" }).click();
    await expect(page.getByLabel("Spans")).toBeChecked();
    await page.keyboard.press("Escape");

    // Every package that D-52 puts in the bundle ran: router, query, table, base-ui, font.
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() =>
        document.fonts.check('1em "Geist Mono Variable"'),
      ),
    ).toBe(true);
    const loaded = await page.evaluate(() =>
      [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => f.family),
    );
    expect(loaded.join()).toContain("Geist Mono Variable");

    expect(await violations(page)).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test("nuqs reads and writes search params inside the hash URL", async ({
  page,
}) => {
  const problems = watch(page);
  await recordViolations(page);
  await page.goto(`${origin}${BASE_PATH}/`);
  const rows = requestRows(page);
  const search = page.getByLabel("Search", { exact: true });
  await expect(rows).toHaveCount(50);
  await page.evaluate(() => {
    (window as unknown as { __marker: string }).__marker = "same-document";
  });

  // Write: typing sets the param in the hash, not in location.search; the server filters.
  await search.fill("users");
  await expect(rows).toHaveCount(30);
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe("#/?search=users");
  expect(await page.evaluate(() => location.search)).toBe("");

  // A second param next to it, set through the faceted filter.
  await page.getByRole("button", { name: "Status filter" }).click();
  await page.getByRole("option", { name: "error" }).click();
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(6);
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toMatch(/^#\/\?(search=users&status=error|status=error&search=users)$/);

  // Read: reload restores both from the URL.
  await page.reload();
  await expect(search).toHaveValue("users");
  await expect(
    page.getByRole("button", { name: "Status filter" }),
  ).toContainText("error");
  await expect(rows).toHaveCount(6);

  // Navigate to a trace (client-side, same document) and come back with Back.
  await page.evaluate(() => {
    (window as unknown as { __marker: string }).__marker = "same-document";
  });
  const [firstId] = await rowTraceIds(page);
  await rows.first().getByRole("link").click();
  await expect(page.getByTestId("trace-id")).toHaveText(firstId as string);
  expect(await page.evaluate(() => location.hash)).toBe(`#/traces/${firstId}`);
  expect(
    await page.evaluate(
      () => (window as unknown as { __marker?: string }).__marker,
    ),
  ).toBe("same-document");

  await page.goBack();
  await expect(search).toHaveValue("users");
  await expect(rows).toHaveCount(6);
  expect(await page.evaluate(() => location.hash)).toMatch(/search=users/);

  // Reset clears every param.
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(rows).toHaveCount(50);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/");

  // A deep link with a param opens already filtered; an invalid value is ignored.
  await page.goto(`${origin}${BASE_PATH}/#/?search=health&status=bogus`);
  await expect(search).toHaveValue("health");
  await expect(rows).toHaveCount(30);

  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
});
