import type { Server } from "node:http";
import type {
  AppMapResponse,
  ClassStatsResponse,
  DependenciesResponse,
} from "@nestrix-js/protocol";
import { expect, test } from "@playwright/test";

import { watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { generatedClasses, generatedMap } from "./mock-classes-map.ts";
import { generatedDependencies } from "./mock-insights.ts";
import { BASE_PATH, startServer } from "./serve.ts";

// Phase 15, P15-01: Dependencies, Classes and Map show the change against the previous window
// from the optional fields of their answers, and "—" with the reason when there is none.
let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash: string) => `${origin}${BASE_PATH}/#/${hash}`;
const SHOTS = "test-results";
const NOTE = "Statistics started less than two windows ago.";

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});

/** The previous window had half the calls and twice the time per call. */
function classesWithPrevious(minutes: number): ClassStatsResponse {
  const base = generatedClasses(minutes);
  const calls = base.classes.reduce((n, c) => n + c.calls, 0);
  const own = base.classes.reduce((n, c) => n + (c.ownMs ?? 0), 0);
  return {
    ...base,
    classes: base.classes.map((c, i) =>
      // The last class is new: no previous.
      i === base.classes.length - 1
        ? c
        : {
            ...c,
            previous: {
              calls: Math.round(c.calls / 2),
              errors: 0,
              totalMs: c.totalMs,
              avgMs: c.avgMs * 2,
              ownMs: c.ownMs === null ? null : c.ownMs / 2,
            },
          },
    ),
    previousCovered: true,
    note: null,
    previousTotals: {
      classes: base.classes.length,
      calls: calls / 2,
      errors: 0,
      totalMs: 1,
      ownMs: own / 2,
    },
  };
}

function dependenciesWithPrevious(minutes: number): DependenciesResponse {
  const base = generatedDependencies(minutes);
  const calls = base.dependencies.reduce((n, d) => n + d.calls, 0);
  return {
    ...base,
    dependencies: base.dependencies.map((d, i) =>
      i === 0
        ? d
        : {
            ...d,
            previous: {
              calls: Math.round(d.calls / 2),
              errors: 0,
              errorRate: 0,
              totalMs: d.totalMs,
              p50Ms: d.p50Ms,
              p95Ms: d.p95Ms * 2,
            },
          },
    ),
    previousCovered: true,
    note: null,
    previousTotals: {
      dependencies: base.dependencies.length,
      calls: calls / 2,
      errors: 0,
      slowestP95Ms: 1000,
    },
  };
}

function mapWithPrevious(minutes: number): AppMapResponse {
  const base = generatedMap(minutes);
  const calls = base.edges.reduce((n, e) => n + e.calls, 0);
  return {
    ...base,
    edges: base.edges.map((e) => ({
      ...e,
      previous: {
        calls: Math.round(e.calls / 2),
        errors: 0,
        p50Ms: e.p50Ms,
        p95Ms: e.p95Ms / 2,
      },
    })),
    previousCovered: true,
    note: null,
    previousTotals: {
      targets: base.nodes.length - 1,
      calls: calls / 2,
      errors: 0,
      slowestP95Ms: 450,
    },
  };
}

const delta = (page: import("@playwright/test").Page, tile: string) =>
  page.getByTestId(tile).getByTestId("delta");

for (const scheme of ["dark", "light"] as const) {
  test(`dependencies in ${scheme} mode: tiles and rows show the change (screenshot)`, async ({
    page,
  }) => {
    mock.dependenciesAnswer = dependenciesWithPrevious;
    await page.emulateMedia({ colorScheme: scheme });
    const problems = watch(page);
    await page.goto(url("dependencies"));
    await expect(page.getByTestId("kpi-calls")).toBeVisible();
    // Calls doubled; the error rate did not move; the slowest p95 (420 ms) fell from 1 s.
    await expect(delta(page, "kpi-calls")).toHaveText("+100%");
    await expect(delta(page, "kpi-slowest")).toHaveAttribute(
      "data-tone",
      "better",
    );
    await expect(delta(page, "kpi-error-rate")).not.toHaveText("—");
    // The first dependency (redis) is new; the others' p95 fell to half.
    const rows = page.getByTestId("dependency-row");
    await expect(
      rows.filter({ hasText: "redis" }).getByTestId("delta"),
    ).toHaveText("new");
    await expect(
      rows.filter({ hasText: "api.stripe.com" }).getByTestId("delta"),
    ).toHaveAttribute("data-tone", "better");
    await page.screenshot({
      path: `${SHOTS}/p15-dependencies-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });

  test(`classes in ${scheme} mode: tiles and rows show the change (screenshot)`, async ({
    page,
  }) => {
    mock.classStats = classesWithPrevious;
    await page.emulateMedia({ colorScheme: scheme });
    const problems = watch(page);
    await page.goto(url("classes"));
    await expect(page.getByTestId("kpi-calls")).toBeVisible();
    await expect(delta(page, "kpi-calls")).toHaveText("+100%");
    await expect(delta(page, "kpi-own")).toHaveAttribute("data-tone", "worse");
    const rows = page.getByTestId("class-row");
    // Sorted by total time: the class with a previous window first, the new class last.
    await expect(rows.first().getByTestId("delta")).toHaveAttribute(
      "data-tone",
      "better",
    );
    await expect(rows.last().getByTestId("delta")).toHaveText("new");
    await page.screenshot({
      path: `${SHOTS}/p15-classes-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });

  test(`map in ${scheme} mode: tiles and edges show the change (screenshot)`, async ({
    page,
  }) => {
    mock.appMap = mapWithPrevious;
    await page.emulateMedia({ colorScheme: scheme });
    const problems = watch(page);
    await page.goto(url("map"));
    await expect(page.getByTestId("kpi-calls")).toBeVisible();
    await expect(delta(page, "kpi-calls")).toHaveText("+100%");
    // p95 doubled against the previous window: worse.
    await expect(delta(page, "kpi-slowest-edge")).toHaveAttribute(
      "data-tone",
      "worse",
    );
    await expect(
      page.getByTestId("map-edge-row").first().getByTestId("delta"),
    ).toHaveAttribute("data-tone", "worse");
    await page.screenshot({
      path: `${SHOTS}/p15-map-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("a previous window that is not covered shows a dash with the reason", async ({
  page,
}) => {
  mock.dependenciesAnswer = (m) => ({
    ...generatedDependencies(m),
    previousCovered: false,
    note: NOTE,
  });
  mock.classStats = (m) => ({
    ...generatedClasses(m),
    previousCovered: false,
    note: NOTE,
  });
  mock.appMap = (m) => ({
    ...generatedMap(m),
    previousCovered: false,
    note: NOTE,
  });
  for (const route of ["dependencies", "classes", "map"]) {
    await page.goto(url(route));
    const tile = page.getByTestId("kpi-calls");
    await expect(tile).toBeVisible();
    await expect(tile.getByTestId("delta")).toHaveText("—");
    await expect(tile.getByTestId("delta")).toHaveAttribute("title", NOTE);
  }
});

test("an older server without the fields keeps the dashes", async ({
  page,
}) => {
  for (const route of ["dependencies", "classes", "map"]) {
    await page.goto(url(route));
    const tile = page.getByTestId("kpi-calls");
    await expect(tile).toBeVisible();
    await expect(tile.getByTestId("delta")).toHaveAttribute(
      "data-tone",
      "unknown",
    );
  }
});

test("phone width: no horizontal overflow with the change columns", async ({
  page,
}) => {
  mock.dependenciesAnswer = dependenciesWithPrevious;
  mock.classStats = classesWithPrevious;
  mock.appMap = mapWithPrevious;
  await page.setViewportSize({ width: 390, height: 800 });
  for (const route of ["dependencies", "classes", "map"]) {
    await page.goto(url(route));
    await expect(page.getByTestId("kpi-calls")).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
