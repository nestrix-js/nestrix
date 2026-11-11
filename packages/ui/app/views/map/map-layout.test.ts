import type { MapEdge, MapNode } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  errorLevel,
  formatRate,
  layoutMap,
  MAP_HEIGHT,
  MAP_WIDTH,
  truncate,
} from "@/views/map/map-layout";

const node = (id: string, kind: MapNode["kind"] = "database"): MapNode => ({
  id,
  kind,
  name: id,
});
const edge = (to: string, over: Partial<MapEdge> = {}): MapEdge => ({
  from: "app",
  to,
  calls: 1,
  errors: 0,
  p50Ms: 1,
  p95Ms: 1,
  ...over,
});

describe("layoutMap", () => {
  it("puts the app in the centre and spreads the targets around it, first at the top", () => {
    const { nodes } = layoutMap(
      [node("a"), node("app", "app"), node("b"), node("c"), node("d")],
      [],
    );
    const at = (id: string) => nodes.find((n) => n.id === id);
    expect(at("app")).toMatchObject({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
    expect(at("a")?.x).toBe(MAP_WIDTH / 2);
    expect(at("a")?.y).toBeLessThan(MAP_HEIGHT / 2);
    // Four targets: opposite pairs are mirror images through the centre.
    expect(at("b")?.x).toBeGreaterThan(MAP_WIDTH / 2);
    expect(at("c")?.y).toBeGreaterThan(MAP_HEIGHT / 2);
    expect(at("d")?.x).toBeLessThan(MAP_WIDTH / 2);
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(MAP_WIDTH);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(MAP_HEIGHT);
    }
    expect(new Set(nodes.map((n) => `${n.x},${n.y}`)).size).toBe(5);
  });

  it("joins edges to node positions, labels the middle, and drops edges to unknown nodes", () => {
    const { nodes, edges } = layoutMap(
      [node("app", "app"), node("db")],
      [edge("db", { calls: 7 }), edge("ghost")],
    );
    expect(edges).toHaveLength(1);
    const db = nodes.find((n) => n.id === "db");
    expect(edges[0]).toMatchObject({
      calls: 7,
      x1: MAP_WIDTH / 2,
      y1: MAP_HEIGHT / 2,
      x2: db?.x,
      y2: db?.y,
    });
    expect(edges[0]?.labelX).toBeCloseTo(((db?.x ?? 0) + MAP_WIDTH / 2) / 2, 0);
  });

  it("copes with no nodes and with no app node", () => {
    expect(layoutMap([], [])).toEqual({ nodes: [], edges: [] });
    expect(layoutMap([node("a"), node("b")], []).nodes).toHaveLength(2);
  });
});

describe("errorLevel and formatRate", () => {
  it("grades by the share of calls that failed", () => {
    expect(errorLevel(0, 10)).toBe("none");
    expect(errorLevel(1, 100)).toBe("low");
    expect(errorLevel(5, 100)).toBe("high");
    expect(errorLevel(1, 0)).toBe("none");
  });

  it("formats rates", () => {
    expect(formatRate(0, 10)).toBe("0%");
    expect(formatRate(1, 40)).toBe("2.5%");
    expect(formatRate(50, 100)).toBe("50%");
    expect(formatRate(0, 0)).toBe("-");
  });
});

describe("truncate", () => {
  it("cuts long names and keeps short ones", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("layoutMap with several services", () => {
  const nodes = [
    node("service:a", "app"),
    node("service:b", "app"),
    node("service:c", "app"),
    node("db"),
    node("cache", "cache"),
  ];
  const edges = [
    edge("service:b", { from: "service:a" }),
    edge("db", { from: "service:b" }),
  ];
  const layout = layoutMap(nodes, edges);
  const at = (id: string) => layout.nodes.find((n) => n.id === id);
  const fromCentre = (id: string) => {
    const n = at(id);
    if (!n) throw new Error(id);
    return Math.hypot(
      (n.x - MAP_WIDTH / 2) / MAP_WIDTH,
      (n.y - MAP_HEIGHT / 2) / MAP_HEIGHT,
    );
  };

  it("places every node once, with services nearer the middle than targets", () => {
    expect(layout.nodes).toHaveLength(5);
    expect(new Set(layout.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(5);
    for (const s of ["service:a", "service:b", "service:c"])
      for (const t of ["db", "cache"])
        expect(fromCentre(s)).toBeLessThan(fromCentre(t));
  });

  it("keeps every node inside the drawing", () => {
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(MAP_WIDTH);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(MAP_HEIGHT);
    }
  });

  it("marks only service to service edges", () => {
    expect(layout.edges.map((e) => e.serviceToService)).toEqual([true, false]);
  });

  it("keeps a single app in the centre and its edges as target edges", () => {
    const single = layoutMap([node("app", "app"), node("db")], [edge("db")]);
    expect(single.edges[0]?.serviceToService).toBe(false);
    expect(single.nodes.find((n) => n.id === "app")).toMatchObject({
      x: MAP_WIDTH / 2,
      y: MAP_HEIGHT / 2,
    });
  });
});
