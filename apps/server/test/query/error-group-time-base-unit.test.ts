/**
 * Server error groups decide a group's state on one time base (audit, D-107): the span start the
 * SQL bounds by. Regression: the occurrence was placed by its start but `before`, first seen and
 * the state used the exception time, so a group whose first occurrence started 1 ms before the
 * window and failed inside it showed `firstEverUnixMs` inside the window yet state `ongoing`.
 */
import { describe, expect, it } from "vitest";
import {
  type ErrorOccurrence,
  groupErrors,
} from "../../src/query/error-groups.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % MIN) + 30_000;

const occ = (
  n: number,
  startUnixMs: number,
  timeUnixMs: number,
): ErrorOccurrence => ({
  traceId: `t${n}`,
  spanId: `s${n}`,
  startUnixMs,
  timeUnixMs,
  errorType: "Error",
  message: "boom",
  route: "/x",
});

describe("server group state time base", () => {
  const from = groupErrors([], 15, NOW).fromUnixMs;

  it("a first occurrence that started 1 ms before the window is before it, whatever its exception time", () => {
    const r = groupErrors(
      [occ(1, from - 1, from + 5), occ(2, NOW - 1_000, NOW - 990)],
      15,
      NOW,
    );
    const g = r.groups[0];
    expect(g?.state).toBe("ongoing");
    expect(g?.firstEverUnixMs).toBe(from - 1);
    // The shown times stay on the exception time.
    expect(g?.lastSeenUnixMs).toBe(NOW - 990);
    expect(g?.count).toBe(1);
  });

  it("state new and firstEver inside the window agree when the first span started inside it", () => {
    const g = groupErrors(
      [occ(1, from, from + 5), occ(2, NOW - 1_000, NOW - 990)],
      15,
      NOW,
    ).groups[0];
    expect(g?.state).toBe("new");
    expect(g?.firstEverUnixMs).toBe(from);
    expect(g?.firstEverUnixMs).toBeGreaterThanOrEqual(from);
  });

  it("the window end is exclusive: a start at now + 1 is outside, now is inside", () => {
    const at = (ms: number) => groupErrors([occ(1, ms, ms)], 15, NOW).groups;
    expect(at(NOW)).toHaveLength(1);
    expect(at(NOW + 1)).toHaveLength(0);
  });
});
