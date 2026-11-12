import { describe, expect, it } from "vitest";

import { rangeOfBuckets } from "@/views/requests/timeline-range";

const MIN = 60_000;
const FIRST = 1_000 * MIN;

describe("rangeOfBuckets", () => {
  it("covers the buckets holding both ends, whatever the order", () => {
    const a = rangeOfBuckets(
      FIRST + 2 * MIN + 5,
      FIRST + 4 * MIN + 9,
      FIRST,
      MIN,
      15,
    );
    expect(a).toEqual({
      fromUnixMs: FIRST + 2 * MIN,
      toUnixMs: FIRST + 5 * MIN - 1,
    });
    expect(
      rangeOfBuckets(FIRST + 4 * MIN + 9, FIRST + 2 * MIN + 5, FIRST, MIN, 15),
    ).toEqual(a);
  });

  it("is one bucket for a click", () => {
    expect(
      rangeOfBuckets(FIRST + 3 * MIN, FIRST + 3 * MIN, FIRST, MIN, 15),
    ).toEqual({
      fromUnixMs: FIRST + 3 * MIN,
      toUnixMs: FIRST + 4 * MIN - 1,
    });
  });

  it("clamps to the window", () => {
    expect(
      rangeOfBuckets(FIRST - 10 * MIN, FIRST + 99 * MIN, FIRST, 5 * MIN, 12),
    ).toEqual({
      fromUnixMs: FIRST,
      toUnixMs: FIRST + 12 * 5 * MIN - 1,
    });
  });
});
