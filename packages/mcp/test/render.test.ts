import { describe, expect, it } from "vitest";
import { renderExplanation } from "../src/render/explain.js";
import { fmtMs, fmtTime, truncate } from "../src/render/format.js";
import { renderErrors, renderRoutes } from "../src/render/lists.js";
import {
  buildTree,
  firstFrames,
  renderTrace,
  repeatedStatements,
} from "../src/render/trace.js";
import {
  errorList,
  errorTrace,
  id,
  nPlusOneTrace,
  REPEATED_SQL,
  routes,
  span,
  T0,
  traceId,
  wideTrace,
} from "./fixtures.js";

describe("formatting", () => {
  it("formats durations compactly and deterministically", () => {
    expect(fmtMs(0.4234)).toBe("0.42ms");
    expect(fmtMs(12.34)).toBe("12.3ms");
    expect(fmtMs(182.4)).toBe("182ms");
    expect(fmtMs(1250)).toBe("1.25s");
    expect(fmtMs(2000)).toBe("2s");
  });
  it("truncates with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
});

describe("self time", () => {
  it("is duration minus the union of the children, clipped to the parent", () => {
    const trace = {
      traceId: traceId(9),
      rootSpanId: id(1),
      resource: {},
      spans: [
        span(1, undefined, "root", 0, 100),
        // Two overlapping children cover 10..60 (50 ms), not 70 ms.
        span(2, 1, "a", 10, 40),
        span(3, 1, "b", 30, 30),
        // A child that runs past its parent is clipped at 100.
        span(4, 1, "c", 90, 50),
      ],
    };
    const tree = buildTree(trace);
    expect(tree.selfMs.get(id(1))).toBeCloseTo(100 - 50 - 10, 6);
    expect(tree.selfMs.get(id(2))).toBe(40);
  });

  it("never goes below zero", () => {
    const trace = {
      traceId: traceId(9),
      rootSpanId: id(1),
      resource: {},
      spans: [span(1, undefined, "root", 0, 10), span(2, 1, "a", 0, 10)],
    };
    expect(buildTree(trace).selfMs.get(id(1))).toBe(0);
  });

  it("treats a span whose parent is missing as a root", () => {
    const trace = {
      traceId: traceId(9),
      rootSpanId: id(2),
      resource: {},
      spans: [span(2, 7, "remote-child", 0, 10)],
    };
    expect(buildTree(trace).roots.map((s) => s.name)).toEqual(["remote-child"]);
  });
});

describe("repeated statements", () => {
  it("reports a statement used three or more times, with its count", () => {
    const tree = buildTree(nPlusOneTrace);
    const repeated = repeatedStatements(tree.spans, tree.byId);
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({
      statement: REPEATED_SQL,
      count: 5,
      totalMs: 50,
      parents: ["OrdersController.list"],
    });
  });

  it("does not report two calls, or statements that only differ in whitespace as different", () => {
    const two = {
      ...nPlusOneTrace,
      spans: nPlusOneTrace.spans.filter(
        (s) =>
          ![
            "0000000000000005",
            "0000000000000006",
            "0000000000000007",
          ].includes(s.spanId),
      ),
    };
    const tree = buildTree(two);
    expect(repeatedStatements(tree.spans, tree.byId)).toEqual([]);
    const spaced = {
      ...nPlusOneTrace,
      spans: [
        ...two.spans,
        span(30, 2, "x", 0, 1, {
          "db.query.text": "SELECT *   FROM\nusers WHERE id = $1",
        }),
      ],
    };
    const t2 = buildTree(spaced);
    expect(repeatedStatements(t2.spans, t2.byId)[0]?.count).toBe(3);
  });
});

describe("renderTrace", () => {
  const out = renderTrace(nPlusOneTrace);

  it("calls out the N+1 statement and its count at the top, before the tree", () => {
    expect(out).toContain(`5x ${REPEATED_SQL}`);
    expect(out.indexOf("Repeated statements")).toBeLessThan(
      out.indexOf("Span tree"),
    );
    expect(out).toContain("under OrdersController.list");
  });

  it("draws an indented tree with durations and self times", () => {
    expect(out).toMatch(/^GET \/orders \[server\] 300ms self \d+(\.\d+)?ms/m);
    expect(out).toMatch(
      /^ {2}OrdersController\.list \[internal\] 290ms self /m,
    );
    expect(out).toMatch(/^ {4}SELECT users \[client\] 10ms /m);
    // Root self time: 300 minus the controller's 2..292.
    expect(out).toContain("GET /orders [server] 300ms self 10ms");
  });

  it("marks slow spans and lists them longest first", () => {
    expect(out).toContain("Slow spans");
    expect(out).toMatch(/- SELECT orders: 180ms \(self 180ms, 60% of trace\)/);
    expect(out).toMatch(/SELECT orders \[client\] 180ms <SLOW>/);
    expect(out).not.toMatch(/SELECT users \[client\] 10ms <SLOW>/);
  });

  it("shows only useful attributes and collapses statement whitespace", () => {
    expect(out).toContain("postgresql: SELECT * FROM orders WHERE open");
    expect(out).not.toContain("cookie");
    expect(out).not.toContain("process.pid");
  });

  it("is the same whatever the order of the stored spans", () => {
    const shuffled = {
      ...nPlusOneTrace,
      spans: [...nPlusOneTrace.spans].reverse(),
    };
    expect(renderTrace(shuffled)).toBe(out);
  });

  it("shows an error with its message and only the first 3 stack frames", () => {
    const text = renderTrace(errorTrace);
    expect(text).toContain("Errors (2)");
    expect(text).toContain(
      "- OrdersService.load: BadGatewayException: Payments service unavailable",
    );
    expect(text).toContain(
      "at OrdersService.load (/app/orders.service.ts:31:11)",
    );
    expect(text).toContain(
      "at OrdersController.get (/app/orders.controller.ts:12:5)",
    );
    expect(text).toContain("at Layer.handle");
    expect(text).not.toContain("at next (");
    expect(text).toMatch(/OrdersService\.load \[internal\] 35ms <ERROR>/);
    // The root has an error status but no exception event: its status message is shown.
    expect(text).toContain("- GET /orders/:id: Payments service unavailable");
  });

  it("extracts at most three `at` lines from a stack", () => {
    expect(
      firstFrames(
        errorTrace.spans[1]?.events[0]?.attributes["exception.stacktrace"],
      ),
    ).toHaveLength(3);
    expect(firstFrames(undefined)).toEqual([]);
  });

  it("caps a large trace, keeps errors and slow spans, and says what was left out", () => {
    const trace = wideTrace(600);
    const text = renderTrace(trace, { maxSpans: 50 });
    const drawn = text
      .split("\n")
      .filter((l) => /\[(server|internal|client)\]/.test(l));
    expect(drawn.length).toBeLessThanOrEqual(55);
    expect(drawn.length).toBeGreaterThanOrEqual(10);
    expect(text).toMatch(/slow-step \[internal\] 400ms <SLOW>/);
    expect(text).toMatch(/failing-step \[internal\] 5ms <ERROR>/);
    expect(text).toMatch(
      /\.\.\. \d+ spans not shown, [\d.]+m?s total: tick x\d+/,
    );
    expect(text).toContain("Output limited to about 50 of 604 spans");
  });

  it("draws every span of a trace within the limit, without a truncation note", () => {
    const text = renderTrace(wideTrace(20));
    expect(text).not.toContain("not shown");
    expect(text).not.toContain("Output limited");
    expect(text.match(/^\s+tick \[internal\]/gm)).toHaveLength(20);
  });

  it("handles an empty trace", () => {
    expect(
      renderTrace({
        traceId: traceId(5),
        rootSpanId: "",
        resource: {},
        spans: [],
      }),
    ).toMatch(/no spans stored/);
  });
});

describe("renderExplanation", () => {
  it("ranks the span with the most self time first and names the N+1", () => {
    const text = renderExplanation({
      route: "/orders",
      method: "GET",
      windowMinutes: 15,
      stats: routes.routes.slice(0, 1),
      summaries: [],
      traces: [nPlusOneTrace],
      knownRoutes: ["GET /orders"],
    });
    const ranked = text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(ranked[0]).toMatch(/^1\. SELECT orders \[db\]: 180ms/);
    expect(text).toContain("p95 310ms");
    expect(text).toContain("By class");
    expect(text).toContain(`5x ${REPEATED_SQL}`);
    expect(text).toContain("N+1 suspect");
  });

  it("says so when the route has no statistics or no stored traces", () => {
    const text = renderExplanation({
      route: "/nope",
      windowMinutes: 15,
      stats: [],
      summaries: [],
      traces: [],
      knownRoutes: ["GET /orders"],
    });
    expect(text).toContain("No statistics for /nope");
    expect(text).toContain("GET /orders");
    expect(text).toContain("No stored traces for this route");
  });
});

describe("lists", () => {
  it("sorts routes by p95 and notes that every request is counted", () => {
    const text = renderRoutes(routes);
    expect(text.indexOf("/orders ")).toBeLessThan(text.indexOf("/orders/:id"));
    expect(text).toContain("Every request is counted");
    expect(text).toContain("20%");
  });

  it("truncates a long route table with a note", () => {
    const many = {
      ...routes,
      routes: Array.from({ length: 40 }, (_, i) => ({
        ...(routes.routes[0] as (typeof routes.routes)[number]),
        route: `/r${i}`,
        p95Ms: i,
      })),
    };
    const text = renderRoutes(many);
    expect(text).toContain("... 15 more routes not shown.");
    expect(text).toContain("/r39");
    expect(text).not.toContain("/r0 ");
  });

  it("groups identical errors with their count", () => {
    const text = renderErrors(errorList);
    expect(text).toContain(
      "- 3x BadGatewayException: Payments service unavailable (latest trace",
    );
  });
});

describe("times", () => {
  it("are UTC, whatever the local time zone", () => {
    expect(fmtTime(T0)).toBe("2026-11-11T12:26:40Z");
  });
});
