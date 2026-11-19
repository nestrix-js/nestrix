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

describe("the arrow of a change", () => {
  it("follows the sign for every tone, a neutral one included", () => {
    const html = (text: string, tone: "worse" | "better" | "neutral") =>
      renderToStaticMarkup(createElement(Delta, { text, tone }));
    expect(html("+7%", "neutral")).toContain("lucide-arrow-up");
    expect(html("−7%", "neutral")).toContain("lucide-arrow-down");
    expect(html("+7%", "worse")).toContain("lucide-arrow-up");
    expect(html("−7%", "better")).toContain("lucide-arrow-down");
  });
  it("draws none for a change of zero", () => {
    const html = renderToStaticMarkup(
      createElement(Delta, { text: "0%", tone: "neutral" }),
    );
    expect(html).not.toContain("<svg");
  });
});

describe("a percent unit", () => {
  it("is written against the number, not as a unit of its own", () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, {
        testId: "kpi-x",
        label: "Error rate",
        value: "1.9",
        unit: "%",
      }),
    );
    expect(html).toContain("1.9%");
    expect(html).not.toContain('text-xs text-muted-foreground">%');
  });
});
