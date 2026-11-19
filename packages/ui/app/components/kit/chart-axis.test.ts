import { describe, expect, it } from "vitest";

import {
  assignLabelRows,
  crossesDay,
  gridTicks,
  hhmm,
  shortDate,
  timeAxisLabels,
  yTickLabel,
} from "@/components/kit/chart-axis";

const local = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe("hhmm", () => {
  it("writes the local clock time with two digits and 24 hours", () => {
    expect(hhmm(local(2026, 11, 19, 9, 5))).toBe("09:05");
    expect(hhmm(local(2026, 11, 19, 23, 59))).toBe("23:59");
    expect(hhmm(local(2026, 11, 19, 0, 0))).toBe("00:00");
  });
});

describe("shortDate", () => {
  it("writes the month name and the day", () => {
    expect(shortDate(local(2026, 11, 9, 12))).toBe("Nov 9");
    expect(shortDate(local(2026, 1, 31, 12))).toBe("Jan 31");
  });
});

describe("crossesDay", () => {
  it("is false within one local day and true across midnight", () => {
    expect(
      crossesDay(local(2026, 11, 19, 0, 1), local(2026, 11, 19, 23, 59)),
    ).toBe(false);
    expect(
      crossesDay(local(2026, 11, 19, 23, 50), local(2026, 11, 20, 0, 10)),
    ).toBe(true);
  });

  it("tells the same day of different months apart", () => {
    expect(crossesDay(local(2026, 10, 5, 12), local(2026, 11, 5, 12))).toBe(
      true,
    );
  });
});

describe("timeAxisLabels", () => {
  const sec = (ms: number) => ms / 1000;

  it("labels ticks with the clock time only when the range stays in one day", () => {
    const ticks = [
      sec(local(2026, 11, 19, 10, 0)),
      sec(local(2026, 11, 19, 10, 10)),
    ];
    expect(timeAxisLabels(ticks, false)).toEqual(["10:00", "10:10"]);
  });

  it("adds the date to the first tick and to the tick that starts a new day", () => {
    const ticks = [
      sec(local(2026, 11, 19, 22, 0)),
      sec(local(2026, 11, 19, 23, 0)),
      sec(local(2026, 11, 20, 0, 0)),
      sec(local(2026, 11, 20, 1, 0)),
    ];
    expect(timeAxisLabels(ticks, true)).toEqual([
      "22:00\nNov 19",
      "23:00",
      "00:00\nNov 20",
      "01:00",
    ]);
  });

  it("keeps an empty label for a missing tick", () => {
    expect(timeAxisLabels([null], false)).toEqual([""]);
  });
});

describe("yTickLabel", () => {
  const ms = (v: number) => `${v.toFixed(2)} ms`;

  it("writes zero as a bare 0 whatever the unit", () => {
    expect(yTickLabel(0, ms)).toBe("0");
  });

  it("formats any other value with the unit's formatter", () => {
    expect(yTickLabel(7.5, ms)).toBe("7.50 ms");
    expect(yTickLabel(null, ms)).toBe("");
  });
});

describe("gridTicks", () => {
  it("gives two to four round values at or below the maximum", () => {
    expect(gridTicks(1800)).toEqual([500, 1000, 1500]);
    expect(gridTicks(100)).toEqual([50, 100]);
    expect(gridTicks(99_999)).toEqual([20_000, 40_000, 60_000, 80_000]);
    expect(gridTicks(7)).toEqual([2, 4, 6]);
    expect(gridTicks(1)).toEqual([0.5, 1]);
  });

  it("never gives more than four ticks, whatever the magnitude", () => {
    for (const max of [0.003, 0.9, 13, 480, 99_999, 4_000_000]) {
      const ticks = gridTicks(max);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(4);
      expect(Math.max(...ticks)).toBeLessThanOrEqual(max * (1 + 1e-9));
    }
  });

  it("keeps whole numbers for counts", () => {
    expect(gridTicks(1, true)).toEqual([1]);
    expect(gridTicks(3, true)).toEqual([1, 2, 3]);
    expect(gridTicks(10, true).every(Number.isInteger)).toBe(true);
  });

  it("is empty without a positive maximum", () => {
    expect(gridTicks(0)).toEqual([]);
    expect(gridTicks(Number.NaN)).toEqual([]);
    expect(gridTicks(-5)).toEqual([]);
  });
});

describe("assignLabelRows", () => {
  it("keeps labels that are far apart in the first row", () => {
    expect(
      assignLabelRows(
        [
          { x: 50, width: 30 },
          { x: 200, width: 30 },
          { x: 400, width: 30 },
        ],
        2,
      ),
    ).toEqual([0, 0, 0]);
  });

  it("moves a label that would touch the one before it to the next row", () => {
    expect(
      assignLabelRows(
        [
          { x: 100, width: 30 },
          { x: 120, width: 30 },
        ],
        2,
      ),
    ).toEqual([0, 1]);
  });

  it("counts the gap: labels exactly touching still need another row", () => {
    expect(
      assignLabelRows(
        [
          { x: 100, width: 40 },
          { x: 142, width: 40 },
        ],
        2,
        6,
      ),
    ).toEqual([0, 1]);
    expect(
      assignLabelRows(
        [
          { x: 100, width: 40 },
          { x: 146, width: 40 },
        ],
        2,
        6,
      ),
    ).toEqual([0, 0]);
  });

  it("uses the last row when every row is taken", () => {
    expect(
      assignLabelRows(
        [
          { x: 100, width: 40 },
          { x: 105, width: 40 },
          { x: 110, width: 40 },
        ],
        2,
      ),
    ).toEqual([0, 1, 1]);
  });
});
