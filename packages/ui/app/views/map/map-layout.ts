import type { MapEdge, MapNode } from "@nestrix/protocol";

export const MAP_WIDTH = 760;
export const MAP_HEIGHT = 440;
/** Targets sit on an ellipse, wider than tall, so side labels fit. */
const RADIUS_X = 290;
const RADIUS_Y = 160;
/** With several services, they sit on a smaller inner ellipse and the targets stay outside it. */
const INNER_RADIUS_X = 120;
const INNER_RADIUS_Y = 62;

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
  /** Both ends are services: a call from one service to another, drawn apart from the targets. */
  serviceToService: boolean;
}

export interface MapLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * Radial layout. One `app` node (an embedded dashboard, or the standalone server filtered to
 * one service): it sits in the centre and every other node on an ellipse around it. Several
 * `app` nodes (one per service): the services on an inner ellipse and everything else on the
 * outer one, so service-to-service edges stay short. Both rings are evenly spaced from the top,
 * clockwise, in the order the API gave the nodes. Edges whose ends are not in `nodes` are
 * dropped. Without an `app` node all nodes share the outer ellipse.
 */
export function layoutMap(
  nodes: readonly MapNode[],
  edges: readonly MapEdge[],
): MapLayout {
  const cx = MAP_WIDTH / 2;
  const cy = MAP_HEIGHT / 2;
  const apps = nodes.filter((n) => n.kind === "app");
  const around = nodes.filter((n) => n.kind !== "app");
  const placed: PlacedNode[] = [];
  const ring = (list: readonly MapNode[], rx: number, ry: number) =>
    list.forEach((n, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / list.length;
      placed.push({
        ...n,
        x: round(cx + rx * Math.cos(angle)),
        y: round(cy + ry * Math.sin(angle)),
      });
    });
  if (apps.length === 1) placed.push({ ...(apps[0] as MapNode), x: cx, y: cy });
  else ring(apps, INNER_RADIUS_X, INNER_RADIUS_Y);
  ring(around, RADIUS_X, RADIUS_Y);
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
      serviceToService: a.kind === "app" && b.kind === "app",
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
