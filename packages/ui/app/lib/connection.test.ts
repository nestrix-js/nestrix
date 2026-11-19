import { describe, expect, it } from "vitest";

import { formatHm, lostConnectionText } from "@/lib/connection";

describe("connection banner", () => {
  it("writes the last good time as HH:mm with leading zeros", () => {
    expect(formatHm(new Date(2026, 10, 19, 7, 5).getTime())).toBe("07:05");
    expect(formatHm(new Date(2026, 10, 19, 21, 48).getTime())).toBe("21:48");
  });
  it("names the time of the last good answer", () => {
    const at = new Date(2026, 10, 19, 9, 30).getTime();
    expect(lostConnectionText(at)).toBe(
      "Lost connection to the server, showing data from 09:30",
    );
  });
  it("does not invent a time when no answer ever arrived", () => {
    expect(lostConnectionText(undefined)).toBe("Could not reach the server");
    expect(lostConnectionText(0)).toBe("Could not reach the server");
  });
});
