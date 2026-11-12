import type { MapEdge, MapNode } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  edgesOf,
  edgeWidth,
  errorLevel,
  formatRate,
  HEALTH_LABEL,
  healthOf,
  layoutMap,
  MAP_HEIGHT,
  MAP_WIDTH,
  nodeStats,
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

describe("node health", () => {
  it("is idle without calls, ok when quiet and fast, degraded on any error or a slow p95, failing from 5% errors or a p95 of a second", () => {
    expect(healthOf({ calls: 0, errors: 0, p95Ms: 0 })).toBe("idle");
    expect(healthOf({ calls: 100, errors: 0, p95Ms: 299 })).toBe("ok");
    expect(healthOf({ calls: 100, errors: 1, p95Ms: 10 })).toBe("degraded");
    expect(healthOf({ calls: 100, errors: 0, p95Ms: 300 })).toBe("degraded");
    expect(healthOf({ calls: 100, errors: 5, p95Ms: 10 })).toBe("failing");
    expect(healthOf({ calls: 100, errors: 0, p95Ms: 1000 })).toBe("failing");
    expect(HEALTH_LABEL.failing).toBe("failing");
  });

  it("takes a node's numbers from the edges into it, and from its own edges when nothing calls it", () => {
    const edges = [
      edge("db", { calls: 120, p50Ms: 3, p95Ms: 21 }),
      edge("stripe", { calls: 20, errors: 4, p50Ms: 180, p95Ms: 900 }),
      edge("stripe", { calls: 5, p50Ms: 10, p95Ms: 50 }),
    ];
    expect(nodeStats("stripe", edges)).toEqual({
      calls: 25,
      errors: 4,
      p50Ms: 180,
      p95Ms: 900,
      direction: "in",
      health: "failing",
    });
    const app = nodeStats("app", edges);
    expect(app.direction).toBe("out");
    expect(app.calls).toBe(145);
    expect(nodeStats("db", edges).health).toBe("ok");
    expect(nodeStats("nowhere", edges).health).toBe("idle");
  });
});

describe("edgeWidth", () => {
  it("grows with call volume between 1.5 and 6", () => {
    expect(edgeWidth(0, 100)).toBe(1.5);
    expect(edgeWidth(5, 0)).toBe(1.5);
    expect(edgeWidth(100, 100)).toBe(6);
    expect(edgeWidth(1000, 100)).toBe(6);
    const small = edgeWidth(4, 400);
    const mid = edgeWidth(100, 400);
    expect(small).toBeGreaterThan(1.5);
    expect(mid).toBeGreaterThan(small);
    expect(mid).toBeLessThan(6);
  });
});

describe("edgesOf", () => {
  it("lists the edges in or out of a node, busiest first", () => {
    const layout = layoutMap(
      [node("app", "app"), node("a"), node("b", "cache")],
      [edge("a", { calls: 5 }), edge("b", { calls: 50 })],
    );
    expect(edgesOf("app", layout.edges).map((e) => e.to)).toEqual(["b", "a"]);
    expect(edgesOf("a", layout.edges)).toHaveLength(1);
  });
});
