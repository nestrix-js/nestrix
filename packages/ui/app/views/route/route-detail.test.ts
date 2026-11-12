import type {
  ExplainKindRow,
  RouteExplainResponse,
} from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  barWidth,
  callsTone,
  explainParams,
  findingHref,
  formatCalls,
  formatCallsDelta,
  formatMsDelta,
  formatShareOfChange,
  kindSegments,
  noTraces,
  queriesPerRequest,
  releaseKpis,
  resolveCompare,
  routeDetailHref,
  sideNames,
  tooFewTraces,
  windowKpis,
} from "@/views/route/route-detail";

const side = (over: Partial<RouteExplainResponse["before"]> = {}) => ({
  label: "previous",
  fromUnixMs: 0,
  toUnixMs: 60 * 60_000,
  traces: 100,
  meanMs: 200,
  p95Ms: 400,
  errorRate: 0.01,
  ...over,
});

const response = (
  over: Partial<RouteExplainResponse> = {},
): RouteExplainResponse => ({
  mode: "window",
  method: "POST",
  route: "/orders",
  before: side(),
  after: side({ label: "current", meanMs: 400, p95Ms: 700, errorRate: 0.03 }),
  releases: [],
  findings: [],
  summary: "",
  kinds: [],
  statements: [
    {
      statement: "SELECT 1",
      system: "postgresql",
      beforeCalls: 1,
      afterCalls: 7.4,
      beforeMs: 1,
      afterMs: 30,
      beforeEachMs: 1,
      afterEachMs: 4,
    },
    {
      statement: "SELECT 2",
      system: "postgresql",
      beforeCalls: 2,
      afterCalls: 2,
      beforeMs: 2,
      afterMs: 2,
      beforeEachMs: 1,
      afterEachMs: 1,
    },
  ],
  methods: [],
  dependencies: [],
  errors: [],
  slowest: [],
  ...over,
});

describe("routeDetailHref", () => {
  it("carries method and route, encoded", () => {
    expect(routeDetailHref("POST", "/orders/:id")).toBe(
      "/route?method=POST&route=%2Forders%2F%3Aid",
    );
  });
  it("leaves the method out for none and for the overflow bucket's *", () => {
    expect(routeDetailHref(null, "/a")).toBe("/route?route=%2Fa");
    expect(routeDetailHref("*", "/a")).toBe("/route?route=%2Fa");
  });
});

describe("findingHref", () => {
  it("opens the errors of the route, every occurrence", () => {
    expect(
      findingHref(
        {
          kind: "new-error",
          link: {
            view: "errors",
            params: { route: "/orders", type: "Boom" },
          },
        },
        15,
      ),
    ).toBe("/errors?view=all&route=%2Forders&type=Boom");
  });
  it("sends the N+1 filter to Queries, and only for an N+1", () => {
    const link = { view: "queries", params: { q: "SELECT" } } as const;
    expect(findingHref({ kind: "n-plus-one", link }, 60)).toBe(
      "/queries?windowMinutes=60&q=SELECT&nplus=true",
    );
    expect(findingHref({ kind: "new-statement", link }, 60)).toBe(
      "/queries?windowMinutes=60&q=SELECT",
    );
  });
  it("cuts the statement filter to 120 characters", () => {
    const href = findingHref(
      {
        kind: "new-statement",
        link: { view: "queries", params: { q: "x".repeat(300) } },
      },
      15,
    );
    expect(new URLSearchParams(href?.split("?")[1]).get("q")).toBe(
      "x".repeat(120),
    );
  });
  it("sends the dependency name and the class to their pages", () => {
    expect(
      findingHref(
        {
          kind: "slower-dependency",
          link: { view: "dependencies", params: { name: "api.stripe.com" } },
        },
        15,
      ),
    ).toBe("/dependencies?windowMinutes=15&name=api.stripe.com");
    expect(
      findingHref(
        {
          kind: "slower-method",
          link: { view: "classes", params: { class: "A" } },
        },
        15,
      ),
    ).toBe("/classes?windowMinutes=15&class=A");
  });
  it("has no link when the finding has none", () => {
    expect(findingHref({ kind: "faster", link: null }, 15)).toBeNull();
  });
});

describe("number formats", () => {
  it("formats calls per request with a decimal only when needed", () => {
    expect(formatCalls(6.4)).toBe("6.4");
    expect(formatCalls(3)).toBe("3");
    expect(formatCalls(0)).toBe("0");
    expect(formatCalls(Number.NaN)).toBe("—");
  });
  it("formats the change of calls and of time with a real minus", () => {
    expect(formatCallsDelta(3, 9.4)).toBe("+6.4");
    expect(formatCallsDelta(4, 2)).toBe("−2");
    expect(formatCallsDelta(2, 2.01)).toBe("0");
    expect(formatMsDelta(96, 318)).toBe("+222 ms");
    expect(formatMsDelta(24, 6)).toBe("−18.0 ms");
    expect(formatMsDelta(5, 5.01)).toBe("0 ms");
  });
  it("says how much of the change a finding explains", () => {
    expect(formatShareOfChange(0.964)).toBe("96% of the change");
    expect(formatShareOfChange(1.4)).toBe("100% of the change");
    expect(formatShareOfChange(null)).toBeNull();
  });
  it("calls more calls worse", () => {
    expect(callsTone(1, 6)).toBe("worse");
    expect(callsTone(6, 1)).toBe("better");
    expect(callsTone(3, 3)).toBe("neutral");
  });
});

describe("kindSegments and barWidth", () => {
  const kinds: ExplainKindRow[] = [
    { key: "db", beforeMs: 96, afterMs: 318 },
    { key: "app", beforeMs: 72, afterMs: 74 },
    { key: "redis", beforeMs: 0, afterMs: 6 },
  ];
  it("keeps kinds that have time, with shares of the bar", () => {
    const before = kindSegments(kinds, "before");
    expect(before.total).toBe(168);
    expect(before.segments.map((s) => s.key)).toEqual(["db", "app"]);
    expect(before.segments[0]?.fraction).toBeCloseTo(96 / 168);
    const after = kindSegments(kinds, "after");
    expect(after.total).toBe(398);
    expect(after.segments).toHaveLength(3);
    expect(after.segments[0]?.color).toBe("--chart-1");
  });
  it("has no segments without time", () => {
    expect(kindSegments([], "after")).toEqual({ total: 0, segments: [] });
  });
  it("sizes a bar against the longest one, never invisible while it has time", () => {
    expect(barWidth(200, 400)).toBe(50);
    expect(barWidth(400, 400)).toBe(100);
    expect(barWidth(1, 1000)).toBe(2);
    expect(barWidth(0, 400)).toBe(0);
  });
});

describe("states", () => {
  it("tells too few traces from none", () => {
    expect(tooFewTraces(response())).toBe(false);
    expect(tooFewTraces(response({ before: side({ traces: 4 }) }))).toBe(true);
    expect(tooFewTraces(response({ after: side({ traces: 0 }) }))).toBe(true);
    expect(noTraces(response())).toBe(false);
    expect(noTraces(response({ before: side({ traces: 2 }) }))).toBe(false);
    expect(
      noTraces(
        response({ before: side({ traces: 0 }), after: side({ traces: 0 }) }),
      ),
    ).toBe(true);
  });
  it("names the sides by window or release", () => {
    expect(sideNames(response())).toEqual({
      before: "Previous 60 min",
      after: "Last 60 min",
    });
    expect(
      sideNames(
        response({
          mode: "release",
          before: side({ label: "v1" }),
          after: side({ label: "v2" }),
        }),
      ),
    ).toEqual({ before: "v1", after: "v2" });
  });
});

describe("queriesPerRequest", () => {
  it("sums the calls of every statement per side", () => {
    expect(queriesPerRequest(response())).toEqual({ before: 3, after: 9.4 });
  });
});

describe("resolveCompare", () => {
  const releases = ["v3", "v2", "v1"];
  it("is the window unless release is chosen", () => {
    expect(resolveCompare(null, "v1", "v2", releases)).toEqual({
      mode: "window",
      releaseA: null,
      releaseB: null,
    });
  });
  it("compares the two newest releases until picked, and keeps a pick", () => {
    expect(resolveCompare("release", null, null, releases)).toEqual({
      mode: "release",
      releaseA: "v2",
      releaseB: "v3",
    });
    expect(resolveCompare("release", "v1", null, releases)).toEqual({
      mode: "release",
      releaseA: "v1",
      releaseB: "v3",
    });
    expect(resolveCompare("release", null, null, [])).toEqual({
      mode: "release",
      releaseA: null,
      releaseB: null,
    });
  });
});

describe("explainParams", () => {
  const state = {
    method: "POST",
    route: "/orders",
    windowMinutes: 60,
    releaseA: null,
    releaseB: null,
    service: "api",
  };
  it("asks for a window without two releases", () => {
    expect(explainParams(state)).toEqual({
      method: "POST",
      route: "/orders",
      windowMinutes: 60,
      service: "api",
    });
    expect(explainParams({ ...state, releaseA: "v1" })).toHaveProperty(
      "windowMinutes",
      60,
    );
  });
  it("asks for releases, not a window, with both", () => {
    const p = explainParams({ ...state, releaseA: "v1", releaseB: "v2" });
    expect(p).toMatchObject({ releaseA: "v1", releaseB: "v2" });
    expect(p).not.toHaveProperty("windowMinutes");
  });
});

describe("KPI tiles", () => {
  const stats = { count: 3000, errors: 84, p95Ms: 680, p99Ms: 1900 };
  const row = {
    method: "POST",
    route: "/orders",
    before: { count: 2400, errors: 22, p50Ms: 100, p95Ms: 412 },
    after: { count: 3000, errors: 84, p50Ms: 150, p95Ms: 680 },
    delta: { count: 600, errorRate: 0.0193, p50Ms: 50, p95Ms: 268 },
  };
  it("window mode: statistics with their changes, labelled before sampling", () => {
    const tiles = windowKpis(stats, row, true, 15, response());
    const by = Object.fromEntries(tiles.map((t) => [t.id, t]));
    expect(by.throughput).toMatchObject({
      value: "200",
      delta: "+25%",
      was: "160",
      source: "stats",
    });
    expect(by.p95).toMatchObject({
      value: "680 ms",
      delta: "+65%",
      tone: "worse",
      was: "412 ms",
    });
    expect(by.p99).toMatchObject({ value: "1.90 s", delta: "—" });
    expect(by.errors).toMatchObject({ value: "2.8%", tone: "worse" });
    expect(by.errors?.delta).toBe("+1.9 pt");
    expect(by.queries).toMatchObject({
      value: "9.4",
      delta: "+6.4",
      was: "3",
      source: "traces",
    });
  });
  it("window mode: no change without a covered previous window", () => {
    const tiles = windowKpis(stats, row, false, 15, response());
    expect(tiles.find((t) => t.id === "p95")?.delta).toBe("—");
    expect(tiles.find((t) => t.id === "p95")?.tone).toBe("neutral");
  });
  it("window mode: dashes when the route has no statistics", () => {
    const tiles = windowKpis(undefined, undefined, true, 15, response());
    expect(tiles.find((t) => t.id === "throughput")?.value).toBe("—");
    expect(tiles.find((t) => t.id === "errors")?.value).toBe("—");
  });
  it("release mode: every tile is from the sampled traces", () => {
    const tiles = releaseKpis(response({ mode: "release" }));
    expect(tiles.map((t) => t.source)).toEqual([
      "traces",
      "traces",
      "traces",
      "traces",
      "traces",
    ]);
    expect(tiles.find((t) => t.id === "mean")).toMatchObject({
      value: "400 ms",
      delta: "+100%",
      was: "200 ms",
    });
    expect(tiles.find((t) => t.id === "errors")).toMatchObject({
      value: "3.0%",
      delta: "+2.0 pt",
    });
  });
});
