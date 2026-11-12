// P15-02: group state, first seen ever and releases, from the history before the window.
// `apps/server/test/query/error-groups-state-unit.test.ts` runs the same cases against the
// standalone server's copy of the module.
import { describe, expect, it } from "vitest";
import {
  type ErrorOccurrence,
  groupErrors,
  REGRESSION_GAP_MS,
} from "../../src/query/error-groups.js";

const MIN = 60_000;
const HOUR = 3_600_000;
// A whole minute, so the 15-minute window is [NOW - 14 min, NOW + 1 min).
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % MIN);

let n = 0;
const occ = (
  agoMs: number,
  release?: string,
  message = "user 1 not found",
): ErrorOccurrence => ({
  traceId: `t${++n}`,
  spanId: `s${n}`,
  timeUnixMs: NOW - agoMs,
  errorType: "NotFoundException",
  message,
  route: "/users/:id",
  release,
});

const stateOf = (list: ErrorOccurrence[], window = 15) =>
  groupErrors(list, window, NOW).groups[0]?.state;

describe("group state", () => {
  it("new: nothing stored before the window", () => {
    expect(stateOf([occ(10 * MIN), occ(1 * MIN)])).toBe("new");
  });

  it("ongoing: seen before the window with no long gap, still occurring", () => {
    expect(stateOf([occ(2 * HOUR), occ(20 * MIN), occ(1 * MIN)])).toBe(
      "ongoing",
    );
  });

  it("quiet: nothing in the last two buckets, whatever the history", () => {
    expect(stateOf([occ(2 * HOUR), occ(10 * MIN)])).toBe("quiet");
    expect(stateOf([occ(10 * MIN)])).toBe("quiet");
  });

  it("regressed: seen before, absent for 24 hours, back", () => {
    expect(
      stateOf([occ(3 * REGRESSION_GAP_MS), occ(5 * MIN), occ(2 * MIN)]),
    ).toBe("regressed");
    // Just under 24 hours of silence is not a regression.
    expect(
      stateOf([
        occ(REGRESSION_GAP_MS + 5 * MIN - 1),
        occ(5 * MIN),
        occ(2 * MIN),
      ]),
    ).toBe("ongoing");
  });

  it("regressed: the group skipped a release first seen in between", () => {
    const list = [
      occ(5 * HOUR, "1.0.0"),
      // Another error shows 1.1.0 for the first time; the group is not in it.
      occ(3 * HOUR, "1.1.0", "disk full"),
      occ(4 * MIN, "1.2.0"),
      occ(2 * MIN, "1.2.0"),
    ];
    const groups = groupErrors(list, 15, NOW).groups;
    expect(groups.find((g) => g.pattern === "user <n> not found")?.state).toBe(
      "regressed",
    );
  });

  it("a group that appears with a new release is not regressed", () => {
    // 1.1.0 first appears with this very group after it went quiet for 3 hours.
    expect(
      stateOf([
        occ(4 * HOUR, "1.0.0"),
        occ(4 * MIN, "1.1.0"),
        occ(2 * MIN, "1.1.0"),
      ]),
    ).toBe("ongoing");
  });
});

describe("history and releases", () => {
  it("reports first and last seen ever, and the first and last release", () => {
    const g = groupErrors(
      [
        occ(30 * HOUR, "1.0.0"),
        occ(2 * HOUR, "1.1.0"),
        occ(6 * MIN, "1.1.0"),
        occ(2 * MIN, "1.2.0"),
      ],
      15,
      NOW,
    ).groups[0];
    expect(g).toMatchObject({
      count: 2,
      firstEverUnixMs: NOW - 30 * HOUR,
      lastEverUnixMs: NOW - 2 * MIN,
      firstSeenUnixMs: NOW - 6 * MIN,
      firstSeenRelease: "1.0.0",
      lastSeenRelease: "1.2.0",
      releases: [
        { release: "1.1.0", count: 1 },
        { release: "1.2.0", count: 1 },
      ],
    });
  });

  it("omits release fields when no occurrence has one", () => {
    const g = groupErrors([occ(2 * MIN)], 15, NOW).groups[0];
    expect(g?.releases).toBeUndefined();
    expect(g?.firstSeenRelease).toBeUndefined();
    expect(g?.firstEverUnixMs).toBe(NOW - 2 * MIN);
  });

  it("does not make groups of occurrences before the window", () => {
    expect(groupErrors([occ(5 * HOUR)], 15, NOW).groups).toEqual([]);
  });

  it("reports the history it covered", () => {
    const r = groupErrors([occ(30 * HOUR), occ(2 * MIN)], 15, NOW);
    expect(r.history).toEqual({ fromUnixMs: NOW - 30 * HOUR, toUnixMs: NOW });
    const asked = groupErrors([occ(2 * MIN)], 15, NOW, NOW - 7 * 24 * HOUR);
    expect(asked.history?.fromUnixMs).toBe(NOW - 7 * 24 * HOUR);
  });

  it("keeps at most 5 releases, most occurrences first", () => {
    const list = ["a", "b", "c", "d", "e", "f"].flatMap((r, i) =>
      Array.from({ length: 6 - i }, () => occ(2 * MIN, r)),
    );
    const g = groupErrors(list, 15, NOW).groups[0];
    expect(g?.releases?.map((r) => r.release)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});
