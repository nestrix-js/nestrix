// P12-02: the filters a route-detail finding links to (docs/backlog/phase-12.md): Queries `q`,
// Dependencies `name`, Classes `class`, Errors `type`, and the links themselves. Mocked API.
import type { Server } from "node:http";
import { expect, test } from "@playwright/test";

import type { MockApi } from "./mock-api.ts";
import { routeAnswers } from "./mock-overview.ts";
import { slower } from "./mock-route-explain.ts";
import { BASE_PATH, startServer } from "./serve.ts";

let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash: string) => `${origin}${BASE_PATH}/#/${hash}`;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset(0);
});

test("Queries: q keeps statements containing the text, with a chip and a clear button", async ({
  page,
}) => {
  await page.goto(url("queries"));
  await expect(page.getByTestId("queries").locator("tbody tr")).toHaveCount(3);

  await page.goto(url("queries?q=select%20*%20from%20USERS"));
  const rows = page.getByTestId("queries").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("SELECT * FROM users WHERE id = ?");
  await expect(page.getByTestId("statement-filter")).toContainText(
    "select * from USERS",
  );

  await page.getByTestId("clear-statement-filter").click();
  await expect(page.getByTestId("statement-filter")).toHaveCount(0);
  await expect(page).not.toHaveURL(/q=/);
  await expect(rows).toHaveCount(3);
});

test("Queries: text no statement holds says so", async ({ page }) => {
  await page.goto(url("queries?q=DELETE"));
  await expect(page.getByTestId("queries")).toContainText(
    "No statement in this window contains that text.",
  );
});

test("Dependencies: name shows that dependency only, exactly as listed", async ({
  page,
}) => {
  await page.goto(url("dependencies"));
  const rows = page.getByTestId("dependency-row");
  await expect(rows).toHaveCount(4);

  await page.goto(url("dependencies?name=postgresql%20shop"));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("postgresql shop");
  await expect(page.getByTestId("dependency-filter")).toContainText(
    "postgresql shop",
  );

  await page.getByTestId("clear-dependency-filter").click();
  await expect(page).not.toHaveURL(/name=/);
  await expect(rows).toHaveCount(4);
});

test("Dependencies: an unknown name says there are no calls", async ({
  page,
}) => {
  await page.goto(url("dependencies?name=nothing"));
  await expect(page.getByTestId("dependencies-empty")).toContainText(
    "No calls to nothing",
  );
});

test("Classes: class keeps that class only", async ({ page }) => {
  await page.goto(url("classes"));
  const rows = page.getByTestId("class-row");
  await expect(rows).toHaveCount(4);

  await page.goto(url("classes?class=OrdersService"));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("OrdersService");
  await expect(page.getByTestId("class-filter")).toContainText("OrdersService");

  await page.getByTestId("clear-class-filter").click();
  await expect(page).not.toHaveURL(/class=/);
  await expect(rows).toHaveCount(4);
});

test("Errors: type keeps the errors of that exception type", async ({
  page,
}) => {
  mock.errors.push(9);
  await page.goto(url("errors?view=all"));
  const rows = page
    .getByTestId("errors")
    .locator("tbody tr[data-testid=error-row]");
  await expect(rows).toHaveCount(9);

  await page.goto(url("errors?view=all&type=TimeoutError"));
  await expect(rows).toHaveCount(3);
  for (const text of await rows.allTextContents())
    expect(text).toContain("TimeoutError");
  await expect(page.getByTestId("type-filter")).toContainText("TimeoutError");

  await page.getByTestId("clear-type-filter").click();
  await expect(page).not.toHaveURL(/type=/);
  await expect(rows).toHaveCount(9);
});

test("Errors: a type nobody has says so", async ({ page }) => {
  mock.errors.push(3);
  await page.goto(url("errors?view=all&type=Nope"));
  await expect(page.getByText("No loaded errors of this type.")).toBeVisible();
});

test("the finding links of the route page land on those filters", async ({
  page,
}) => {
  mock.routeStats = routeAnswers().stats;
  mock.routeExplain = (q) => slower(q);
  mock.errors.push(9);
  await page.goto(url("route?method=POST&route=%2Forders"));

  await page.getByTestId("finding").nth(0).getByTestId("finding-link").click();
  await expect(page).toHaveURL(/#\/queries\?windowMinutes=15&q=SELECT/);
  await expect(page.getByTestId("statement-filter")).toBeVisible();
  await expect(page.getByTestId("nplus-filter")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.goBack();
  await page.getByTestId("finding").nth(1).getByTestId("finding-link").click();
  await expect(page).toHaveURL(
    /#\/errors\?view=all&route=%2Forders&type=PaymentGatewayError/,
  );
  await expect(page.getByTestId("type-filter")).toContainText(
    "PaymentGatewayError",
  );

  await page.goBack();
  await page.getByTestId("finding").nth(2).getByTestId("finding-link").click();
  await expect(page).toHaveURL(
    /#\/dependencies\?windowMinutes=15&name=redis(\+|%20)cache/,
  );
  await expect(page.getByTestId("dependency-filter")).toContainText(
    "redis cache",
  );
});
