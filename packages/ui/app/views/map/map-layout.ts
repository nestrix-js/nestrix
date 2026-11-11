import type { MapEdge, MapNode } from "@nestrix/protocol";

export const MAP_WIDTH = 760;
export const MAP_HEIGHT = 440;
/** Targets sit on an ellipse, wider than tall, so side labels fit. */
const RADIUS_X = 290;
const RADIUS_Y = 160;

export interface PlacedNode extends MapNode {
  x: number;
  y: number;
}

export interface PlacedEdge extends MapEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Where the label goes: the middle of the edge. */
  labelX: number;
  labelY: number;
}

export interface MapLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * Radial layout: the `app` node in the centre, every other node on an ellipse around it, evenly
 * spaced from the top, clockwise, in the order the API gave them. Edges whose ends are not in
 * `nodes` are dropped. Without an `app` node all nodes share the ellipse.
 */
export function layoutMap(
  nodes: readonly MapNode[],
  edges: readonly MapEdge[],
): MapLayout {
  const cx = MAP_WIDTH / 2;
  const cy = MAP_HEIGHT / 2;
  const center = nodes.find((n) => n.kind === "app");
  const around = nodes.filter((n) => n !== center);
  const placed: PlacedNode[] = [];
  if (center) placed.push({ ...center, x: cx, y: cy });
  around.forEach((n, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / around.length;
    placed.push({
      ...n,
      x: round(cx + RADIUS_X * Math.cos(angle)),
      y: round(cy + RADIUS_Y * Math.sin(angle)),
    });
  });
  const byId = new Map(placed.map((n) => [n.id, n]));
  const placedEdges: PlacedEdge[] = [];
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    placedEdges.push({
      ...e,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      labelX: round((a.x + b.x) / 2),
      labelY: round((a.y + b.y) / 2),
    });
  }
  return { nodes: placed, edges: placedEdges };
}

export type ErrorLevel = "none" | "low" | "high";

/** Edge colour class: no errors, under 5% of calls, or 5% and over. */
export function errorLevel(errors: number, calls: number): ErrorLevel {
  if (errors <= 0 || calls <= 0) return "none";
  return errors / calls >= 0.05 ? "high" : "low";
}

/** "2.5%" like the routes view; "-" without calls. */
export function formatRate(errors: number, calls: number): string {
  if (calls <= 0) return "-";
  const percent = (errors / calls) * 100;
  if (percent === 0) return "0%";
  return `${percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`;
}

/** A node label cut to fit its box. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
