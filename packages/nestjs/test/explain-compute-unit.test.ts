// P12-01: the pure computation behind `GET api/v1/routes/explain`, with hand-built traces. Every
// finding fires at its threshold and stays quiet just under it; the server's copy of the module
// is checked against this one in apps/server/test/query/explain.test.ts.
import type { ExplainFinding } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";
import {
  computeExplain,
  type ExplainSideInput,
  type ExplainSpanInput,
  type ExplainTraceInput,
  formatMs,
  MAX_FINDINGS,
  MAX_TRACES_PER_SIDE,
} from "../src/explain/compute.js";

type SpanInit = Partial<ExplainSpanInput> & { durationMs: number };

/** A root of `durationMs` with direct children (not overlapping each other). */
function trace(
  i: number,
  durationMs: number,
  children: SpanInit[] = [],
  extra: Partial<ExplainTraceInput> = {},
): ExplainTraceInput {
  const root: ExplainSpanInput = {
    spanId: "root",
    durationMs,
    error: false,
    key: "app",
    exceptions: [],
  };
  return {
    traceId: `t${i}`,
    startUnixMs: 1_000_000 + i * 1000,
    durationMs,
    status: 200,
    error: false,
    spans: [
      root,
      ...children.map((c, j) => ({
        spanId: `c${j}`,
        parentSpanId: "root",
        error: false,
        key: "other" as const,
        exceptions: [],
        ...c,
      })),
    ],
    ...extra,
  };
}

const side = (
  label: string,
  n: number,
  build: (i: number) => ExplainTraceInput,
): ExplainSideInput => ({
  label,
  fromUnixMs: 0,
  toUnixMs: 1,
  traces: Array.from({ length: n }, (_, i) => build(i)),
});

function run(before: ExplainSideInput, after: ExplainSideInput) {
  return computeExplain({
    mode: "window",
    method: "GET",
    route: "/orders",
    before,
    after,
    releases: [],
  });
}

const stmt = (text = "SELECT 1", ms = 1) => ({
  durationMs: ms,
  key: "db" as const,
  statement: { statement: text, system: "postgresql" },
});
const dep = (ms: number, error = false) => ({
  durationMs: ms,
  key: "http-out" as const,
  error,
  dependency: { name: "api.stripe.com", kind: "http" as const },
});
const method = (ms: number, name = "OrdersService.load") => ({
  durationMs: ms,
  key: "app" as const,
  method: name,
});
const thrown = (type: string, message = "boom") => ({
  durationMs: 1,
  exceptions: [{ type, message }],
});

const kindsOf = (fs: ExplainFinding[]) => fs.map((f) => f.kind);

/** Same root time on both sides, so only the child under test differs. */
const same = (children: (i: number) => SpanInit[]) => (i: number) =>
  trace(i, 100, children(i));

describe("computeExplain: sides and too few traces", () => {
  it("says there are not enough traces and gives no findings when a side has fewer than 5", () => {
    const r = run(
      side("previous", 3, () => trace(0, 100)),
      side("current", 41, () => trace(0, 400, [stmt("SELECT 1", 300)])),
    );
    expect(r.summary).toBe(
      "Not enough traces to compare (3 before, 41 after).",
    );
    expect(r.findings).toEqual([]);
    // The tables are still filled.
    expect(r.statements).toHaveLength(1);
    expect(r.before.traces).toBe(3);
    expect(r.after.traces).toBe(41);
    expect(
      run(
        side("previous", 5, () => trace(0, 100)),
        side("current", 4, () => trace(0, 100)),
      ).summary,
    ).toBe("Not enough traces to compare (5 before, 4 after).");
  });

  it("reports the side figures: mean, nearest-rank p95, failure rate", () => {
    const after = side("current", 20, (i) =>
      trace(i, (i + 1) * 10, [], { error: i < 5, status: i < 5 ? 500 : 200 }),
    );
    const r = run(
      side("previous", 5, () => trace(0, 100)),
      after,
    );
    expect(r.before).toMatchObject({
      label: "previous",
      traces: 5,
      meanMs: 100,
      p95Ms: 100,
      errorRate: 0,
    });
    expect(r.after).toMatchObject({
      label: "current",
      traces: 20,
      meanMs: 105,
      p95Ms: 190,
      errorRate: 0.25,
    });
    expect(
      run(
        side("a", 0, () => trace(0, 1)),
        side("b", 0, () => trace(0, 1)),
      ).before,
    ).toMatchObject({ traces: 0, meanMs: 0, p95Ms: 0, errorRate: 0 });
  });

  it("reads only the newest 2,000 traces of a side", () => {
    const after: ExplainSideInput = {
      label: "current",
      fromUnixMs: 0,
      toUnixMs: 1,
      traces: Array.from({ length: MAX_TRACES_PER_SIDE + 100 }, (_, i) =>
        // The 100 oldest are slow.
        trace(i, i < 100 ? 10_000 : 50),
      ),
    };
    const r = run(
      side("previous", 5, () => trace(0, 50)),
      after,
    );
    expect(r.after.traces).toBe(MAX_TRACES_PER_SIDE);
    expect(r.after.meanMs).toBe(50);
  });

  it("passes the mode, method, route and releases through (release mode)", () => {
    const r = computeExplain({
      mode: "release",
      method: null,
      route: "/orders",
      before: side("1.0", 5, () => trace(0, 100)),
      after: side("2.0", 5, () => trace(0, 100)),
      releases: ["2.0", "1.0"],
    });
    expect(r).toMatchObject({
      mode: "release",
      method: null,
      route: "/orders",
      releases: ["2.0", "1.0"],
      before: { label: "1.0" },
      after: { label: "2.0" },
    });
  });
});

describe("statements", () => {
  it("new-statement fires at 5 ms per request and not just under", () => {
    const fires = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side(
        "c",
        10,
        same(() => [stmt("SELECT 1", 5)]),
      ),
    );
    expect(kindsOf(fires.findings)).toEqual(["new-statement"]);
    expect(fires.findings[0]).toMatchObject({
      direction: "worse",
      deltaMs: 5,
      title: "A new statement runs once per request (SELECT 1), adding 5 ms.",
      link: { view: "queries", params: { q: "SELECT 1" } },
    });
    const under = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side(
        "c",
        10,
        same(() => [stmt("SELECT 1", 4.9)]),
      ),
    );
    expect(under.findings).toEqual([]);
  });

  it("n-plus-one fires at 3 calls per request, whatever each call costs", () => {
    const fires = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side(
        "c",
        10,
        same(() => [stmt(), stmt(), stmt()]),
      ),
    );
    expect(kindsOf(fires.findings)).toEqual(["n-plus-one"]);
    expect(fires.findings[0]?.title).toBe(
      "A new statement runs 3.0 times per request (SELECT 1), adding 3 ms.",
    );
    const two = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side(
        "c",
        10,
        same(() => [stmt(), stmt()]),
      ),
    );
    expect(two.findings).toEqual([]);
  });

  it("n-plus-one against a known count needs 2x and at least 3 calls", () => {
    const calls = (n: number) => () => Array.from({ length: n }, () => stmt());
    // 2 -> 5: 2.5x and >= 3.
    const fires = run(
      side("p", 10, same(calls(2))),
      side("c", 10, same(calls(5))),
    );
    expect(kindsOf(fires.findings)).toEqual(["n-plus-one"]);
    expect(fires.findings[0]?.title).toBe(
      "A statement runs 5.0 times per request, was 2.0 (SELECT 1), adding 3 ms.",
    );
    // 3 -> 5 is under 2x.
    expect(
      run(side("p", 10, same(calls(3))), side("c", 10, same(calls(5))))
        .findings,
    ).toEqual([]);
    // 1 -> 2 is 2x but under 3 calls.
    expect(
      run(side("p", 10, same(calls(1))), side("c", 10, same(calls(2))))
        .findings,
    ).toEqual([]);
  });

  it("n-plus-one takes precedence over new-statement: one finding per statement", () => {
    const r = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side(
        "c",
        10,
        same(() => Array.from({ length: 6 }, () => stmt("SELECT 1", 10))),
      ),
    );
    expect(kindsOf(r.findings)).toEqual(["n-plus-one"]);
    expect(r.findings[0]?.deltaMs).toBe(60);
  });

  it("slower-statement needs the same calls, 1.5x per run and +5 ms per request", () => {
    const once = (ms: number) => () => [stmt("SELECT 1", ms)];
    const fires = run(
      side("p", 10, same(once(10))),
      side("c", 10, same(once(20))),
    );
    expect(kindsOf(fires.findings)).toEqual(["slower-statement"]);
    expect(fires.findings[0]).toMatchObject({
      deltaMs: 10,
      title:
        "A statement now takes 20 ms per run, was 10 ms (SELECT 1), adding 10 ms per request.",
    });
    // 1.49x.
    expect(
      run(side("p", 10, same(once(10))), side("c", 10, same(once(14.9))))
        .findings,
    ).toEqual([]);
    // 3x but only +2 ms per request.
    expect(
      run(side("p", 10, same(once(1))), side("c", 10, same(once(3)))).findings,
    ).toEqual([]);
    // Calls moved by more than 20% (and not an N+1): not "same calls".
    const many = (n: number, ms: number) => () =>
      Array.from({ length: n }, () => stmt("SELECT 1", ms));
    expect(
      run(side("p", 10, same(many(5, 10))), side("c", 10, same(many(7, 16))))
        .findings,
    ).toEqual([]);
    // Within 20%: still the same calls.
    expect(
      kindsOf(
        run(side("p", 10, same(many(5, 10))), side("c", 10, same(many(6, 16))))
          .findings,
      ),
    ).toEqual(["slower-statement"]);
  });

  it("cuts statements to 80 characters in titles and 120 in the link, and keeps the table text", () => {
    const text = `SELECT ${"x".repeat(200)}`;
    const r = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side(
        "c",
        10,
        same(() => [stmt(text, 10)]),
      ),
    );
    const f = r.findings[0];
    expect(f?.title).toContain(`(${text.slice(0, 79)}…)`);
    expect(f?.link?.params.q).toBe(`${text.slice(0, 119)}…`);
    expect(r.statements[0]?.statement).toBe(text);
    const huge = run(
      side("p", 5, () => trace(0, 100)),
      side("c", 5, () => trace(0, 100, [stmt("y".repeat(3000))])),
    );
    expect(huge.statements[0]?.statement).toHaveLength(2000);
  });

  it("builds statement rows per request with the mean per execution", () => {
    const r = run(
      side(
        "p",
        4,
        same(() => [stmt("SELECT 1", 10)]),
      ),
      side(
        "c",
        4,
        same(() => [
          stmt("SELECT 1", 10),
          stmt("SELECT 1", 30),
          stmt("SELECT 2", 5),
        ]),
      ),
    );
    expect(r.statements.find((s) => s.statement === "SELECT 1")).toEqual({
      statement: "SELECT 1",
      system: "postgresql",
      beforeCalls: 1,
      afterCalls: 2,
      beforeMs: 10,
      afterMs: 40,
      beforeEachMs: 10,
      afterEachMs: 20,
    });
    expect(r.statements.find((s) => s.statement === "SELECT 2")).toMatchObject({
      beforeCalls: 0,
      beforeEachMs: null,
      afterEachMs: 5,
    });
  });
});

describe("a database call is both a statement and a dependency", () => {
  it("is reported under each", () => {
    const call = () => [
      {
        ...stmt("SELECT 1", 60),
        dependency: { name: "postgresql orders-db", kind: "db" as const },
      },
    ];
    const r = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side("c", 10, same(call)),
    );
    expect(kindsOf(r.findings).sort()).toEqual([
      "new-statement",
      "slower-dependency",
    ]);
  });
});

describe("dependencies", () => {
  const once =
    (ms: number, error = false) =>
    () => [dep(ms, error)];

  it("slower-dependency fires at 1.3x and +20 ms, not under either", () => {
    const fires = run(
      side("p", 10, same(once(100))),
      side("c", 10, same(once(130))),
    );
    expect(kindsOf(fires.findings)).toEqual(["slower-dependency"]);
    expect(fires.findings[0]).toMatchObject({
      deltaMs: 30,
      title: "api.stripe.com takes 130 ms per request, was 100 ms.",
      link: { view: "dependencies", params: { name: "api.stripe.com" } },
    });
    expect(
      run(side("p", 10, same(once(100))), side("c", 10, same(once(129))))
        .findings,
    ).toEqual([]);
    // 2.9x but +19 ms.
    expect(
      run(side("p", 10, same(once(10))), side("c", 10, same(once(29))))
        .findings,
    ).toEqual([]);
    expect(
      kindsOf(
        run(side("p", 10, same(once(10))), side("c", 10, same(once(30))))
          .findings,
      ),
    ).toEqual(["slower-dependency"]);
  });

  it("formats seconds with one decimal and says when a dependency is new", () => {
    const r = run(
      side("p", 10, same(once(640))),
      side("c", 10, same(once(1100))),
    );
    expect(r.findings[0]?.title).toBe(
      "api.stripe.com takes 1.1 s per request, was 640 ms.",
    );
    const fresh = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side("c", 10, same(once(200))),
    );
    expect(fresh.findings[0]?.title).toBe(
      "api.stripe.com is new: 200 ms per request.",
    );
  });

  it("dependency-errors fires when the error rate is up 5 points with 3 failed calls", () => {
    const failing = (n: number) => (i: number) => [dep(10, i < n)];
    // 5 of 100 traces fail: 5% and 5 calls.
    const fires = run(
      side("p", 100, same(failing(0))),
      side("c", 100, same(failing(5))),
    );
    expect(kindsOf(fires.findings)).toEqual(["dependency-errors"]);
    expect(fires.findings[0]).toMatchObject({
      deltaMs: null,
      shareOfChange: null,
      title: "api.stripe.com failed 5% of calls, was 0%.",
    });
    // 4 of 100: under 5 points.
    expect(
      run(side("p", 100, same(failing(0))), side("c", 100, same(failing(4))))
        .findings,
    ).toEqual([]);
    // 10% but only 2 failed calls.
    expect(
      run(side("p", 20, same(failing(0))), side("c", 20, same(failing(2))))
        .findings,
    ).toEqual([]);
    expect(
      kindsOf(
        run(side("p", 20, same(failing(0))), side("c", 20, same(failing(3))))
          .findings,
      ),
    ).toEqual(["dependency-errors"]);
  });
});

describe("methods", () => {
  const m = (ms: number) => () => [method(ms)];
  it("slower-method fires at 1.5x and +10 ms, not under", () => {
    const fires = run(side("p", 10, same(m(20))), side("c", 10, same(m(30))));
    expect(kindsOf(fires.findings)).toEqual(["slower-method"]);
    expect(fires.findings[0]).toMatchObject({
      deltaMs: 10,
      title: "OrdersService.load takes 30 ms per request, was 20 ms.",
      link: { view: "classes", params: { class: "OrdersService" } },
    });
    expect(
      run(side("p", 10, same(m(20))), side("c", 10, same(m(29.9)))).findings,
    ).toEqual([]);
    // 1.9x but +9 ms.
    expect(
      run(side("p", 10, same(m(10))), side("c", 10, same(m(19)))).findings,
    ).toEqual([]);
  });

  it("uses own time: a method's children are not counted in it", () => {
    const withChild = (ms: number) => () => [
      method(ms),
      { ...stmt("SELECT 1", ms - 5), parentSpanId: "c0" },
    ];
    const r = run(
      side("p", 5, same(withChild(20))),
      side("c", 5, same(withChild(40))),
    );
    const row = r.methods.find((x) => x.name === "OrdersService.load");
    expect(row).toMatchObject({ beforeMs: 5, afterMs: 5 });
  });
});

describe("errors", () => {
  const withErrors =
    (n: number, type = "PaymentGatewayError") =>
    (i: number) =>
      trace(i, 100, i < n ? [thrown(type)] : []);

  it("new-error fires at 2 traces, not at 1", () => {
    const fires = run(
      side("p", 20, withErrors(0)),
      side("c", 20, withErrors(2)),
    );
    expect(kindsOf(fires.findings)).toEqual(["new-error"]);
    expect(fires.findings[0]).toMatchObject({
      title: "PaymentGatewayError is new: 2 traces.",
      deltaMs: null,
      shareOfChange: null,
      link: {
        view: "errors",
        params: { route: "/orders", type: "PaymentGatewayError" },
      },
    });
    expect(
      run(side("p", 20, withErrors(0)), side("c", 20, withErrors(1))).findings,
    ).toEqual([]);
  });

  it("more-errors fires at 3x and 5 traces, not under either", () => {
    const fires = run(
      side("p", 20, withErrors(2)),
      side("c", 20, withErrors(6)),
    );
    expect(kindsOf(fires.findings)).toEqual(["more-errors"]);
    expect(fires.findings[0]?.title).toBe(
      "PaymentGatewayError is in 6 traces, was 2.",
    );
    expect(
      run(side("p", 20, withErrors(2)), side("c", 20, withErrors(5))).findings,
    ).toEqual([]);
    // 3x but fewer than 5.
    expect(
      run(side("p", 20, withErrors(1)), side("c", 20, withErrors(4))).findings,
    ).toEqual([]);
  });

  it("counts a type once per trace, names an untyped exception Error, and cuts the message", () => {
    const r = run(
      side("p", 5, () => trace(0, 100)),
      side("c", 5, (i) =>
        trace(i, 100, [
          {
            durationMs: 1,
            exceptions: [{ message: "m".repeat(400) }, { message: "again" }],
          },
        ]),
      ),
    );
    expect(r.errors).toEqual([
      {
        type: "Error",
        message: `${"m".repeat(299)}…`,
        beforeTraces: 0,
        afterTraces: 5,
      },
    ]);
  });
});

describe("faster", () => {
  const stmtMs = (ms: number) => () => [stmt("SELECT 1", ms)];
  it("fires when time per request fell by 30% and 10 ms", () => {
    const r = run(
      side("p", 10, same(stmtMs(100))),
      side("c", 10, same(stmtMs(60))),
    );
    expect(kindsOf(r.findings)).toEqual(["faster"]);
    expect(r.findings[0]).toMatchObject({ direction: "better", deltaMs: -40 });
  });

  it("stays quiet just under: 29% or 9 ms", () => {
    expect(
      run(side("p", 10, same(stmtMs(100))), side("c", 10, same(stmtMs(71))))
        .findings,
    ).toEqual([]);
    expect(
      run(side("p", 10, same(stmtMs(20))), side("c", 10, same(stmtMs(11))))
        .findings,
    ).toEqual([]);
  });

  it("reports a faster dependency and method", () => {
    const r = run(
      side(
        "p",
        10,
        same(() => [dep(200), method(50)]),
      ),
      side(
        "c",
        10,
        same(() => [dep(100), method(20)]),
      ),
    );
    expect(r.findings.map((f) => [f.kind, f.direction, f.deltaMs])).toEqual([
      ["faster", "better", -100],
      ["faster", "better", -30],
    ]);
  });
});

describe("ranking and shareOfChange", () => {
  it("orders worse timing by deltaMs, then errors, then faster; at most 8", () => {
    const r = run(
      side("p", 10, (i) => trace(i, 300, [method(20), dep(200)])),
      side("c", 10, (i) =>
        trace(i, 400, [
          method(40),
          dep(100),
          stmt("SELECT 1", 60),
          thrown("Boom"),
        ]),
      ),
    );
    expect(r.findings.map((f) => [f.kind, f.direction])).toEqual([
      ["new-statement", "worse"],
      ["slower-method", "worse"],
      ["new-error", "worse"],
      ["faster", "better"],
    ]);
    expect(r.findings[0]?.deltaMs).toBe(60);
  });

  it("caps findings at 8", () => {
    const many = (n: number) => () =>
      Array.from({ length: n }, (_, k) => method(30, `C${k}.run`));
    const r = run(
      side(
        "p",
        10,
        same(() => []),
      ),
      side("c", 10, same(many(12))),
    );
    expect(r.findings).toHaveLength(MAX_FINDINGS);
    expect(r.methods).toHaveLength(12);
  });

  it("shareOfChange is deltaMs over the change in mean, clamped, null under 10 ms", () => {
    const grow = (extra: number) =>
      run(
        side("p", 10, (i) => trace(i, 100)),
        side("c", 10, (i) => trace(i, 100 + extra, [stmt("SELECT 1", extra)])),
      );
    expect(grow(40).findings[0]?.shareOfChange).toBe(1);
    // Half of a 100 ms change.
    const half = run(
      side("p", 10, (i) => trace(i, 100)),
      side("c", 10, (i) => trace(i, 200, [stmt("SELECT 1", 50)])),
    );
    expect(half.findings[0]?.shareOfChange).toBe(0.5);
    // The mean moved 6 ms: no share.
    const small = run(
      side("p", 10, (i) => trace(i, 100)),
      side("c", 10, (i) => trace(i, 106, [stmt("SELECT 1", 6)])),
    );
    expect(small.findings[0]?.shareOfChange).toBeNull();
    // A worse finding while the route got faster overall clamps to 0.
    const clamp = run(
      side("p", 10, (i) => trace(i, 500)),
      side("c", 10, (i) => trace(i, 100, [stmt("SELECT 1", 20)])),
    );
    expect(clamp.findings[0]?.shareOfChange).toBe(0);
  });
});

describe("summary", () => {
  it("names the kind that explains the change and the first worse finding", () => {
    const r = run(
      side("p", 10, (i) => trace(i, 214)),
      side("c", 10, (i) => trace(i, 436, [stmt("SELECT 1", 222)])),
    );
    expect(r.summary).toBe(
      "Mean time went from 214 ms to 436 ms; most of it is database time (+222 ms), mainly one new statement.",
    );
    expect(r.kinds.find((k) => k.key === "db")).toEqual({
      key: "db",
      beforeMs: 0,
      afterMs: 222,
    });
  });

  it("says nothing about a kind when none explains half of the change", () => {
    const r = run(
      side("p", 10, (i) => trace(i, 100)),
      side("c", 10, (i) =>
        trace(i, 200, [
          { durationMs: 40, key: "db" },
          { durationMs: 30, key: "http-out" },
          { durationMs: 30, key: "messaging" },
        ]),
      ),
    );
    expect(r.summary).toBe("Mean time went from 100 ms to 200 ms.");
  });

  it("describes an improvement", () => {
    const r = run(
      side("p", 10, (i) => trace(i, 400, [stmt("SELECT 1", 250)])),
      side("c", 10, (i) => trace(i, 200, [stmt("SELECT 1", 50)])),
    );
    expect(r.summary).toBe(
      "Mean time went from 400 ms to 200 ms; most of it is database time (-200 ms), mainly a faster statement.",
    );
  });

  it("says about the same when the change is under 10% and under 10 ms", () => {
    const r = run(
      side("p", 10, (i) => trace(i, 100)),
      side("c", 10, (i) => trace(i, 105)),
    );
    expect(r.summary).toBe("Mean time is about the same (100 ms → 105 ms).");
    // 9% of 100 is 9 ms: same. 12 ms is not.
    expect(
      run(
        side("p", 10, (i) => trace(i, 100)),
        side("c", 10, (i) => trace(i, 112)),
      ).summary,
    ).toMatch(/^Mean time went from 100 ms to 112 ms/);
    // 4 ms on 20 ms is 20%: not the same.
    expect(
      run(
        side("p", 10, (i) => trace(i, 20)),
        side("c", 10, (i) => trace(i, 24)),
      ).summary,
    ).toMatch(/^Mean time went from/);
  });

  it("says errors went up when only they changed", () => {
    const r = run(
      side("p", 10, (i) => trace(i, 100)),
      side("c", 10, (i) =>
        trace(i, 100, [], { error: i < 3, status: i < 3 ? 500 : 200 }),
      ),
    );
    expect(r.summary).toBe("Errors went from 0% to 30%.");
  });

  it("formats durations like the UI", () => {
    expect(formatMs(640)).toBe("640 ms");
    expect(formatMs(1100)).toBe("1.1 s");
    expect(formatMs(999.4)).toBe("999 ms");
  });
});

describe("kinds, slowest traces", () => {
  it("sums own time by kind per request", () => {
    const r = run(
      side("p", 4, (i) => trace(i, 100, [stmt("SELECT 1", 30)])),
      side("c", 4, (i) => trace(i, 100, [stmt("SELECT 1", 60), dep(10)])),
    );
    const by = Object.fromEntries(
      r.kinds.map((k) => [k.key, [k.beforeMs, k.afterMs]]),
    );
    expect(by.db).toEqual([30, 60]);
    expect(by["http-out"]).toEqual([0, 10]);
    expect(by.app).toEqual([70, 30]);
    expect(r.kinds.map((k) => k.key)).toEqual([
      "db",
      "http-out",
      "redis",
      "messaging",
      "app",
      "other",
    ]);
  });

  it("lists the 10 slowest traces of the after side, slowest first, with kinds fitting the duration", () => {
    const r = run(
      side("p", 5, (i) => trace(i, 100)),
      side("c", 25, (i) => trace(i, 100 + i, [stmt("SELECT 1", 40)])),
    );
    expect(r.slowest).toHaveLength(10);
    expect(r.slowest.map((t) => t.durationMs)).toEqual([
      124, 123, 122, 121, 120, 119, 118, 117, 116, 115,
    ]);
    expect(r.slowest[0]).toMatchObject({
      traceId: "t24",
      status: 200,
      error: false,
    });
    for (const t of r.slowest) {
      expect(t.byKind.reduce((n, k) => n + k.ms, 0)).toBeLessThanOrEqual(
        t.durationMs + 1e-9,
      );
    }
    expect(r.slowest[0]?.byKind).toEqual([
      { key: "db", ms: 40 },
      { key: "app", ms: 84 },
    ]);
  });

  it("scales overlapping children so the kinds never exceed the trace duration", () => {
    const r = run(
      side("p", 5, (i) => trace(i, 100)),
      side("c", 5, (i) =>
        trace(i, 100, [
          {
            durationMs: 90,
            key: "http-out",
            dependency: { name: "a", kind: "http" },
          },
          { durationMs: 90, key: "db" },
          // Own time of a grandchild is not hidden by a parent that was shorter.
        ]),
      ),
    );
    const t = r.slowest[0];
    expect(t?.byKind.reduce((n, k) => n + k.ms, 0)).toBeLessThanOrEqual(
      100 + 1e-9,
    );
  });
});
