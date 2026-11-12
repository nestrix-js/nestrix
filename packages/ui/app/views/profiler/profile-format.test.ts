import type { FlameNode } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  cpuByOrigin,
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
    expect(frameKind("node:internal/timers")).toBe("node");
    expect(frameKind("")).toBe("v8");
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

describe("frame origins", () => {
  it("tells apart your code, dependencies, Node built-ins and V8", () => {
    expect(frameKind("file:///srv/app/src/a.ts", "a")).toBe("app");
    expect(
      frameKind("file:///srv/app/node_modules/pg/lib/client.js", "q"),
    ).toBe("deps");
    expect(frameKind("file:///C:/app/node_modules/pg/x.js", "q")).toBe("deps");
    expect(frameKind("/srv/app/dist/main.js", "m")).toBe("app");
    expect(frameKind("C:\\app\\dist\\main.js", "m")).toBe("app");
    expect(frameKind("C:\\app\\node_modules\\pg\\x.js", "m")).toBe("deps");
    expect(frameKind("node:internal/process/task_queues", "t")).toBe("node");
    expect(frameKind("internal/timers", "t")).toBe("node");
    expect(frameKind("", "(garbage collector)")).toBe("v8");
    expect(frameKind("", "(program)")).toBe("v8");
    expect(frameKind("wasm://wasm/abc", "wasm-function[3]")).toBe("node");
    expect(frameKind("wasm://wasm/abc", "(program)")).toBe("v8");
  });

  it("sums each node's own samples by origin and reports what the pruning dropped", () => {
    const root = node(
      "(root)",
      100,
      [
        node("main", 70, [
          node("hot", 40),
          node("lib", 20, [], "file:///app/node_modules/x/index.js"),
        ]),
        node("tick", 10, [], "node:internal/timers"),
        node("(garbage collector)", 15, [], ""),
      ],
      "",
    );
    // main: 70 total, children 60, so 10 self (app); hot 40 (app); lib 20 (deps); tick 10 (node);
    // gc 15 (v8); root 100 total, children 95, so 5 self (v8: empty URL).
    const by = Object.fromEntries(cpuByOrigin(root).map((s) => [s.kind, s]));
    expect(by.app?.samples).toBe(50);
    expect(by.deps?.samples).toBe(20);
    expect(by.node?.samples).toBe(10);
    expect(by.v8?.samples).toBe(20);
    expect(by.pruned).toBeUndefined();
    expect(by.app?.fraction).toBeCloseTo(0.5);

    // A node with samples neither its own nor its children's: the server pruned them.
    const pruned: FlameNode = {
      ...node("(root)", 100, [node("a", 30)], ""),
      selfSamples: 0,
    };
    const shares = cpuByOrigin(pruned);
    expect(shares.find((s) => s.kind === "pruned")?.samples).toBe(70);
    expect(shares.reduce((sum, s) => sum + s.samples, 0)).toBe(100);
  });

  it("answers nothing for an empty profile", () => {
    expect(cpuByOrigin(node("(root)", 0, [], ""))).toEqual([]);
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
    expect(at("(program)")?.kind).toBe("v8");
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
