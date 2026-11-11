import type { FlameNode } from "@nestrix/protocol";
import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatMs,
  frameKind,
  frameLabel,
  layoutFlame,
  nodeAt,
  shortUrl,
  startPauseWarning,
} from "@/views/profiler/profile-format";

const node = (
  functionName: string,
  totalSamples: number,
  children: FlameNode[] = [],
  url = "file:///app/src/main.js",
): FlameNode => ({
  functionName,
  url,
  line: 1,
  selfSamples: totalSamples - children.reduce((s, c) => s + c.totalSamples, 0),
  totalSamples,
  children,
});

const tree = node(
  "(root)",
  100,
  [
    node("main", 80, [
      node("hot", 60),
      node("lib", 20, [], "file:///app/node_modules/x/index.js"),
    ]),
    node("(program)", 20, [], ""),
  ],
  "",
);

describe("frames", () => {
  it("classifies where code lives", () => {
    expect(frameKind("file:///srv/app/dist/main.js")).toBe("app");
    expect(frameKind("file:///srv/app/node_modules/@nestjs/core/x.js")).toBe(
      "deps",
    );
    expect(frameKind("node:internal/timers")).toBe("runtime");
    expect(frameKind("")).toBe("runtime");
  });

  it("prints short locations", () => {
    expect(shortUrl("file:///srv/app/dist/main.js")).toBe("dist/main.js");
    expect(shortUrl("node:internal/timers")).toBe("node:internal/timers");
    expect(frameLabel({ functionName: "hot", url: "", line: 0 })).toBe("hot");
    expect(
      frameLabel({ functionName: "hot", url: "file:///a/b/c.js", line: 7 }),
    ).toBe("hot b/c.js:7");
  });
});

describe("layoutFlame", () => {
  it("places children under their parent by share, left to right", () => {
    const { bars, depth } = layoutFlame(tree);
    expect(depth).toBe(3);
    const at = (name: string) => bars.find((b) => b.node.functionName === name);
    expect(at("(root)")).toMatchObject({ depth: 0, x: 0, width: 1 });
    expect(at("main")).toMatchObject({ depth: 1, x: 0, width: 0.8 });
    expect(at("(program)")).toMatchObject({ depth: 1, x: 0.8, width: 0.2 });
    expect(at("hot")).toMatchObject({
      depth: 2,
      x: 0,
      width: 0.6,
      kind: "app",
    });
    expect(at("lib")).toMatchObject({ depth: 2, x: 0.6, kind: "deps" });
    expect(at("lib")?.width).toBeCloseTo(0.2);
    expect(at("(program)")?.kind).toBe("runtime");
  });

  it("zooms to a node by its path", () => {
    expect(nodeAt(tree, "0.1")?.functionName).toBe("lib");
    const { bars } = layoutFlame(tree, "0");
    expect(bars[0]).toMatchObject({ path: "0", width: 1, depth: 0 });
    expect(bars.find((b) => b.node.functionName === "hot")?.width).toBe(0.75);
    expect(bars.some((b) => b.node.functionName === "(program)")).toBe(false);
    // An unknown path falls back to the root.
    expect(layoutFlame(tree, "9.9").bars[0]?.path).toBe("");
  });

  it("draws nothing for an empty profile and skips sub-pixel bars", () => {
    expect(layoutFlame(node("(root)", 0, [], "")).bars).toEqual([]);
    const wide = node("(root)", 100_000, [
      node("tiny", 1),
      node("big", 99_999),
    ]);
    const names = layoutFlame(wide).bars.map((b) => b.node.functionName);
    expect(names).toEqual(["(root)", "big"]);
  });
});

describe("formatting", () => {
  it("formats durations and sizes", () => {
    expect(formatMs(4.25)).toBe("4.3 ms");
    expect(formatMs(47.6)).toBe("48 ms");
    expect(formatMs(2047.5)).toBe("2.0 s");
    expect(formatMs(30_000)).toBe("30 s");
    expect(formatBytes(950)).toBe("950 B");
    expect(formatBytes(117_521)).toBe("118 KB");
    expect(formatBytes(1_234_567)).toBe("1.2 MB");
  });

  it("warns with the measured pause when there is one, otherwise with the typical one", () => {
    expect(startPauseWarning(47.6)).toContain("48 ms");
    expect(startPauseWarning(null)).toContain("10 ms per MB");
  });
});
