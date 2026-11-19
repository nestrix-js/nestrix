import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Delta, isUnknownDelta } from "@/components/kit/delta";
import { StatTile } from "@/components/kit/stat-tile";

describe("an unknown change", () => {
  it("draws no delta at all", () => {
    expect(isUnknownDelta("—")).toBe(true);
    expect(
      renderToStaticMarkup(
        createElement(Delta, { text: "—", tone: "neutral" }),
      ),
    ).toBe("");
  });
  it("still draws a known one", () => {
    const html = renderToStaticMarkup(
      createElement(Delta, { text: "+12%", tone: "worse" }),
    );
    expect(html).toContain("+12%");
    expect(html).toContain('data-testid="delta"');
  });
  it("leaves the tile's corner empty and keeps the reason as the label's tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, {
        testId: "kpi-x",
        label: "Calls",
        value: "12",
        delta: "—",
        deltaTitle: "No previous window.",
      }),
    );
    expect(html).not.toContain('data-testid="delta"');
    expect(html).not.toContain("—");
    expect(html).toContain('title="No previous window."');
    expect(html).toContain('data-delta="unknown"');
  });
  it("draws the change of a tile that has one", () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, {
        testId: "kpi-x",
        label: "Calls",
        value: "12",
        delta: "+3%",
      }),
    );
    expect(html).toContain('data-testid="delta"');
  });
});
