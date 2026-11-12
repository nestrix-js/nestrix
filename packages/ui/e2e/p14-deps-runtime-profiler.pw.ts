import type { Server } from "node:http";
import type {
  InstanceSummary,
  RemoteProfileSummary,
  RuntimeSample,
} from "@nestrix-js/protocol";
import { expect, test } from "@playwright/test";

import { watch } from "./helpers.ts";
import type { MockApi } from "./mock-api.ts";
import { richProfile } from "./mock-rich-profile.ts";
import { BASE_PATH, startServer } from "./serve.ts";

// Phase 14, P14-04: Dependencies, Runtime and the Profiler (embedded and standalone), in the
// kit's look. Screenshots land in test-results/ for the owner's review.
let server: Server;
let origin: string;
let mock: MockApi;
const url = (hash = "") => `${origin}${BASE_PATH}/#/${hash}`;
const SHOTS = "test-results";
const SCHEMES = ["dark", "light"] as const;

test.beforeAll(async () => {
  ({ server, origin, mock } = await startServer());
});
test.afterAll(() => {
  server.close();
});
test.beforeEach(() => {
  mock.reset();
});
test.afterEach(() => {
  // Drop an instance-level override a test installed on the shared mock.
  delete (mock as Partial<MockApi>).handleRemote;
});

/** A realistic hour: a steady process with a busy stretch near the end. */
function runtimeSamples(count: number): RuntimeSample[] {
  const end = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const busy = Math.max(0, i - count * 0.7) / (count * 0.3);
    return {
      timeUnixMs: end - (count - 1 - i) * 10_000,
      eventLoopP50Ms: 1.1 + busy * 2,
      eventLoopP99Ms: 4 + Math.sin(i / 3) * 1.5 + busy * 52,
      eventLoopMaxMs: 9 + Math.sin(i / 2) * 3 + busy * 70,
      heapUsedBytes: 38_000_000 + i * 220_000 + Math.sin(i / 4) * 2_000_000,
      heapTotalBytes: 62_000_000 + Math.floor(i / 15) * 4_000_000,
      rssBytes: 118_000_000 + i * 150_000,
      externalBytes: 2_100_000 + Math.sin(i) * 80_000,
      cpuUserPercent: 14 + Math.sin(i / 5) * 5 + busy * 38,
      cpuSystemPercent: 3 + Math.sin(i / 7) + busy * 6,
      activeResources: 6 + Math.round(Math.sin(i / 6) * 2 + busy * 4),
    };
  });
}

for (const scheme of SCHEMES) {
  test(`dependencies in ${scheme} mode: health cards, calls chart and table (screenshot)`, async ({
    page,
  }) => {
    const problems = watch(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("dependencies"));
    await expect(page.getByTestId("dependency-card")).toHaveCount(4);
    await expect(page.getByTestId("calls-area")).toBeVisible();
    await expect(page.getByTestId("dependency-row")).toHaveCount(4);
    await expect(page.getByTestId("page-header")).toContainText("Dependencies");
    await expect(
      page.getByTestId("kpi-strip").getByTestId("kpi-value"),
    ).toHaveCount(4);
    // Each card says its status in words, from the error rate and p95.
    for (const card of await page.getByTestId("dependency-card").all()) {
      await expect(card.locator('[data-slot="chip"]')).toContainText(
        /Healthy|Degraded|Failing/,
      );
    }
    await page.screenshot({
      path: `${SHOTS}/p14-dependencies-${scheme}.png`,
      fullPage: true,
    });
    expect(problems.filter((p) => !p.includes("HTTP 404"))).toEqual([]);
  });

  test(`runtime in ${scheme} mode: tiles with thresholds and four charts (screenshot)`, async ({
    page,
  }) => {
    const problems = watch(page);
    mock.runtimeSamples = runtimeSamples(90);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("runtime"));
    await expect(page.getByTestId("tile-loop-p99")).toContainText("ms");
    for (const id of ["eventloop", "memory", "cpu", "handles"]) {
      await expect(
        page.getByTestId(`chart-${id}`).locator("canvas"),
      ).toBeVisible();
    }
    // The busy stretch at the end crosses the thresholds, in words.
    await expect(page.getByTestId("tile-loop-p99")).toContainText("High");
    await expect(page.getByTestId("tile-heap")).toContainText("Normal");
    await expect(page.getByRole("meter")).toHaveCount(3);
    await page.screenshot({
      path: `${SHOTS}/p14-runtime-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });

  test(`profiler in ${scheme} mode: capture, flame graph by origin, top functions and donut (screenshot)`, async ({
    page,
  }) => {
    const problems = watch(page);
    const rich = richProfile();
    const startedAtUnixMs = Date.now() - 95_000;
    const summary = {
      id: "0000000000000001",
      startedAtUnixMs,
      durationMs: 30_000,
      actualDurationMs: 30_047.5,
      startPauseMs: 41.3,
      samples: rich.samples,
      bytes: 412_000,
    };
    mock.profiles = [
      summary,
      {
        ...summary,
        id: "0000000000000002",
        startedAtUnixMs: startedAtUnixMs - 600_000,
      },
    ];
    mock.profileDetails.set(summary.id, {
      ...summary,
      topFunctions: rich.topFunctions,
      flame: rich.flame,
    });
    mock.lastStartPauseMs = 41.3;
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("profiler"));
    await expect(page.getByTestId("flame-graph")).toBeVisible();

    // Every origin appears in the flame graph and in the donut's legend.
    const origins = await page
      .getByTestId("flame-bar")
      .evaluateAll((bars) => [
        ...new Set(bars.map((b) => b.getAttribute("data-origin"))),
      ]);
    expect(origins.sort()).toEqual(["app", "deps", "node", "v8"]);
    await expect(page.getByTestId("flame-legend")).toContainText("Your code");
    await expect(page.getByTestId("flame-legend")).toContainText(
      "node_modules",
    );
    await expect(page.getByTestId("flame-legend")).toContainText(
      "Node built-ins",
    );
    await expect(page.getByTestId("flame-legend")).toContainText("V8");
    await expect(page.getByTestId("origin-row")).toHaveCount(4);
    // The donut is computed from the profile: your code is 910 of 2650 samples.
    await expect(page.getByTestId("origin-donut")).toContainText("34.3%");
    await expect(page.getByTestId("profile-download")).toHaveCount(1);
    await page.screenshot({
      path: `${SHOTS}/p14-profiler-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });

  test(`standalone profiler in ${scheme} mode: instances, a running capture, history and a capture's profile (screenshot)`, async ({
    page,
  }) => {
    const problems = watch(page);
    mock.mode = "standalone";
    mock.remoteProfiler = true;
    const now = Date.now();
    const ids = [
      "7f3c2a91-0000-4000-8000-000000000001",
      "b04e17d2-0000-4000-8000-000000000002",
      "e91a5c03-0000-4000-8000-000000000003",
    ];
    const summary = (
      n: number,
      over: Partial<RemoteProfileSummary>,
    ): RemoteProfileSummary => ({
      id: n.toString(16).padStart(16, "0"),
      service: "orders-api",
      instanceId: ids[1] as string,
      version: "1.8.2",
      state: "done",
      requestedAtUnixMs: now - 300_000,
      startedAtUnixMs: now - 285_000,
      finishedAtUnixMs: now - 250_000,
      durationMs: 30_000,
      actualDurationMs: 30_031,
      samples: 1999,
      bytes: 412_000,
      error: null,
      ...over,
    });
    const running = summary(4, {
      instanceId: ids[0] as string,
      state: "running",
      requestedAtUnixMs: now - 22_000,
      startedAtUnixMs: now - 12_000,
      finishedAtUnixMs: null,
      actualDurationMs: null,
      samples: null,
      bytes: null,
    });
    mock.remoteProfiles = [
      running,
      summary(3, {
        instanceId: ids[2] as string,
        state: "failed",
        samples: null,
        bytes: null,
        actualDurationMs: null,
        error: "busy",
      }),
      summary(2, {
        requestedAtUnixMs: now - 900_000,
        state: "expired",
        samples: null,
        bytes: null,
        actualDurationMs: null,
        error: "never picked up",
      }),
      summary(1, {}),
    ];
    const hosts = [
      "orders-api-6d9f-7f3c",
      "orders-api-6d9f-b04e",
      "orders-api-6d9f-e91a",
    ];
    ids.forEach((id, i) => {
      const instance: InstanceSummary = mock.addInstance(id, {
        service: "orders-api",
        version: "1.8.2",
        host: hosts[i] as string,
        pid: 1 + i,
        lastSeenUnixMs: now - (4 + i * 4) * 1000,
        // P15-03: the first instance is clearly the busiest; the third has no loop figure.
        runtimeSample: {
          cpuPercent: [68, 21, 17][i] as number,
          ...(i < 2 ? { eventLoopP99Ms: [94, 23][i] as number } : {}),
          heapUsedBytes: ([182, 141, 133][i] as number) * 1_000_000,
          rssBytes: ([412, 318, 301][i] as number) * 1_000_000,
          sampledAtUnixMs: now - (4 + i * 4) * 1000,
        },
      });
      if (i === 0) instance.capture = running;
    });
    const rich = richProfile();
    const original = mock.handleRemote.bind(mock);
    mock.handleRemote = (method, path, query, body) => {
      const answer = original(method, path, query, body);
      if (path === "remote-profiles/0000000000000001" && method === "GET") {
        answer.body = {
          ...(answer.body as object),
          samples: rich.samples,
          topFunctions: rich.topFunctions,
          flame: rich.flame,
        };
      }
      return answer;
    };
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("profiler"));
    await expect(page.getByTestId("instance-row")).toHaveCount(3);
    await expect(page.getByTestId("instance-status")).toContainText(
      "Capturing",
    );
    await expect(page.getByTestId("suggested-chip")).toHaveCount(1);
    await expect(
      page.locator(`[data-instance="${ids[0]}"]`).getByTestId("suggested-chip"),
    ).toBeVisible();
    // P15-03: the runtime columns do not push the Capture button out of a 1280 px window.
    const tableOverflow = await page.getByTestId("instances").evaluate((t) => {
      const box = t.parentElement as HTMLElement;
      return box.scrollWidth - box.clientWidth;
    });
    expect(tableOverflow).toBeLessThanOrEqual(0);
    await expect(page.getByTestId("remote-profile-row")).toHaveCount(4);
    await expect(page.getByTestId("state-badge")).toHaveText([
      "Running",
      "Failed",
      "Expired",
      "Done",
    ]);
    await expect(page.getByTestId("flame-graph")).toBeVisible();
    await expect(page.getByTestId("origin-row")).toHaveCount(4);
    await page.screenshot({
      path: `${SHOTS}/p14-profiler-standalone-${scheme}.png`,
      fullPage: true,
    });
    expect(problems).toEqual([]);
  });
}

test("pages hold at phone width without a horizontal page scroll", async ({
  page,
}) => {
  mock.runtimeSamples = runtimeSamples(30);
  const rich = richProfile();
  mock.profiles = [
    {
      id: "0000000000000001",
      startedAtUnixMs: Date.now() - 60_000,
      durationMs: 30_000,
      actualDurationMs: 30_040,
      startPauseMs: 41,
      samples: rich.samples,
      bytes: 412_000,
    },
  ];
  const first = mock.profiles[0];
  if (first)
    mock.profileDetails.set(first.id, {
      ...first,
      topFunctions: rich.topFunctions,
      flame: rich.flame,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const hash of ["dependencies", "runtime", "profiler"]) {
    await page.goto(url(hash));
    await expect(page.getByTestId("page-header")).toBeVisible();
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${hash} overflows horizontally`).toBeLessThanOrEqual(0);
  }
  await page.goto(url("profiler"));
  await expect(page.getByTestId("flame-graph")).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/p14-profiler-phone.png`,
    fullPage: true,
  });
});
