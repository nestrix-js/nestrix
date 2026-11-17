import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as protocol from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";
import { renderExplanation } from "../src/render/explain.js";
import { renderRoutes, renderTraceList } from "../src/render/lists.js";
import * as copy from "../src/render/statistics-wording.js";
import { routes } from "./fixtures.js";

describe("shared statistics wording (issue #45)", () => {
  it("the copy bundled into the mcp package equals the protocol module", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../protocol/src/statistics-wording.ts", import.meta.url),
      ),
      "utf8",
    );
    const bundled = readFileSync(
      fileURLToPath(
        new URL("../src/render/statistics-wording.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(bundled.endsWith(source)).toBe(true);
    for (const mode of ["embedded", "standalone", undefined] as const) {
      expect(copy.statisticsCounting(mode)).toBe(
        protocol.statisticsCounting(mode),
      );
    }
  });

  it("each mode has its own sentence, and unknown states both", () => {
    expect(protocol.statisticsCounting("embedded")).toMatch(
      /count every request/,
    );
    expect(protocol.statisticsCounting("standalone")).toMatch(/stored spans/);
    expect(protocol.statisticsCounting("standalone")).not.toMatch(
      /every request/,
    );
    const both = protocol.statisticsCounting();
    expect(both).toMatch(/every request/);
    expect(both).toMatch(/stored spans/);
  });

  it("the dashboard note uses the same sentence as the tools", () => {
    expect(protocol.statisticsNote({ rate: 0.5 }, "standalone")).toBe(
      protocol.STATISTICS_COUNTING.standalone,
    );
    expect(protocol.statisticsNote({ rate: 0.5 }, "embedded")).toContain(
      protocol.STATISTICS_COUNTING.embedded,
    );
  });

  it("renderers use the sentence of the mode they are given", () => {
    const explain = {
      route: "/orders",
      windowMinutes: 15,
      stats: routes.routes.slice(0, 1),
      summaries: [],
      traces: [],
      knownRoutes: [],
    };
    for (const mode of ["embedded", "standalone"] as const) {
      const other = mode === "embedded" ? "standalone" : "embedded";
      const texts = [
        renderRoutes(routes, mode),
        renderTraceList({ items: [] } as never, "", mode),
        renderExplanation({ ...explain, mode }),
      ];
      for (const text of texts) {
        expect(text).toContain(protocol.STATISTICS_COUNTING[mode]);
        expect(text).not.toContain(protocol.STATISTICS_COUNTING[other]);
      }
    }
  });
});
