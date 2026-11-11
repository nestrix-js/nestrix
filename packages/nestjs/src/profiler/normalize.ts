/**
 * Turning `v8.startCpuProfile().stop()`'s JSON into what the dashboard keeps (P7-02, D-70;
 * spike P7-S1 Q1): the downloadable `.cpuprofile` in `node --cpu-prof`'s form, its top functions
 * by self time and a pruned flame tree. Pure functions; run once per capture, off the request
 * path (`setImmediate` after stop). They throw on a profile they cannot read; the caller catches.
 *
 * Normalisation: `v8.startCpuProfile` reports `scriptId` as a number and a CommonJS file as an
 * absolute path, where the inspector and `node --cpu-prof` (the format Chrome DevTools and
 * speedscope document) give a string and a `file://` URL. Both are rewritten.
 */
import { pathToFileURL } from "node:url";
import type { FlameNode, ProfileFunction } from "@nestrix/protocol";

interface CallFrame {
  functionName: string;
  scriptId: string | number;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
  positionTicks?: unknown;
}

interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/** What a capture keeps besides the JSON string. */
export interface NormalizedProfile {
  /** The `.cpuprofile`, normalised. */
  readonly json: string;
  readonly samples: number;
  /** `endTime - startTime`, microseconds to milliseconds. */
  readonly actualDurationMs: number;
  readonly topFunctions: ProfileFunction[];
  readonly flame: FlameNode;
}

/** Top functions kept. */
export const TOP_FUNCTIONS = 50;
/** A flame child narrower than this share of all samples is pruned. */
export const FLAME_MIN_SHARE = 0.005;
/** Deeper flame nodes are pruned (a runaway recursion must not make the answer huge). */
export const FLAME_MAX_DEPTH = 128;

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/** An absolute path (POSIX or Windows) becomes a `file://` URL; anything else is kept. */
export function normalizeUrl(url: unknown): string {
  if (typeof url !== "string" || url === "") return "";
  if (url.startsWith("/") || WINDOWS_PATH.test(url) || url.startsWith("\\\\")) {
    try {
      return pathToFileURL(url).href;
    } catch {
      return url;
    }
  }
  return url;
}

function isProfile(value: unknown): value is CpuProfile {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<CpuProfile>;
  return (
    Array.isArray(p.nodes) &&
    Array.isArray(p.samples) &&
    Array.isArray(p.timeDeltas) &&
    typeof p.startTime === "number" &&
    typeof p.endTime === "number"
  );
}

const IDLE = "(idle)";
const ROOT = "(root)";

function displayName(name: string): string {
  return name === "" ? "(anonymous)" : name;
}

function keyOf(frame: CallFrame): string {
  return `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}\u0000${frame.columnNumber}`;
}

/**
 * Parses, normalises and summarises a profile. Throws on JSON that is not a CPU profile.
 */
export function normalizeProfile(raw: string): NormalizedProfile {
  const parsed: unknown = JSON.parse(raw);
  if (!isProfile(parsed)) throw new Error("not a CPU profile");
  const profile = parsed;

  const byId = new Map<number, ProfileNode>();
  for (const node of profile.nodes) {
    const frame = node.callFrame;
    frame.scriptId = String(frame.scriptId ?? "0");
    frame.url = normalizeUrl(frame.url);
    if (typeof frame.functionName !== "string") frame.functionName = "";
    if (typeof frame.lineNumber !== "number") frame.lineNumber = -1;
    if (typeof frame.columnNumber !== "number") frame.columnNumber = -1;
    byId.set(node.id, node);
  }

  // Self samples per node, from the samples themselves (`hitCount` is not relied on).
  const self = new Map<number, number>();
  for (const id of profile.samples) self.set(id, (self.get(id) ?? 0) + 1);

  const root = profile.nodes[0];
  if (root === undefined) throw new Error("empty CPU profile");

  // Inclusive samples per node, children first (iterative post-order: deep stacks are possible).
  const total = new Map<number, number>();
  const order: ProfileNode[] = [];
  const stack: ProfileNode[] = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const node = stack.pop() as ProfileNode;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    order.push(node);
    for (const childId of node.children ?? []) {
      const child = byId.get(childId);
      if (child !== undefined) stack.push(child);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i] as ProfileNode;
    let sum = self.get(node.id) ?? 0;
    for (const childId of node.children ?? []) sum += total.get(childId) ?? 0;
    total.set(node.id, sum);
  }

  // Per function: self over every node; total over nodes with no ancestor of the same function.
  const functions = new Map<string, ProfileFunction>();
  const walk: Array<{ node: ProfileNode; enter: boolean }> = [
    { node: root, enter: true },
  ];
  const onPath = new Map<string, number>();
  // V8 emits a tree; a malformed profile with a cycle or a shared child must not loop.
  const entered = new Set<number>();
  while (walk.length > 0) {
    const { node, enter } = walk.pop() as { node: ProfileNode; enter: boolean };
    const frame = node.callFrame;
    const key = keyOf(frame);
    if (!enter) {
      const depth = (onPath.get(key) ?? 1) - 1;
      if (depth === 0) onPath.delete(key);
      else onPath.set(key, depth);
      continue;
    }
    if (entered.has(node.id)) continue;
    entered.add(node.id);
    const name = frame.functionName;
    if (name !== IDLE && name !== ROOT) {
      let entry = functions.get(key);
      if (entry === undefined) {
        entry = {
          functionName: displayName(name),
          url: frame.url,
          line: frame.lineNumber >= 0 ? frame.lineNumber + 1 : 0,
          column: frame.columnNumber >= 0 ? frame.columnNumber + 1 : 0,
          selfSamples: 0,
          totalSamples: 0,
        };
        functions.set(key, entry);
      }
      entry.selfSamples += self.get(node.id) ?? 0;
      if (!onPath.has(key)) entry.totalSamples += total.get(node.id) ?? 0;
    }
    onPath.set(key, (onPath.get(key) ?? 0) + 1);
    walk.push({ node, enter: false });
    for (const childId of node.children ?? []) {
      const child = byId.get(childId);
      if (child !== undefined) walk.push({ node: child, enter: true });
    }
  }
  const topFunctions = [...functions.values()]
    .filter((f) => f.selfSamples > 0)
    .sort(
      (a, b) =>
        b.selfSamples - a.selfSamples || b.totalSamples - a.totalSamples,
    )
    .slice(0, TOP_FUNCTIONS);

  const sampleCount = profile.samples.length;
  const minSamples = Math.max(1, Math.ceil(sampleCount * FLAME_MIN_SHARE));
  const placed = new Set<number>();
  const toFlame = (node: ProfileNode, depth: number): FlameNode => {
    placed.add(node.id);
    const frame = node.callFrame;
    const children: FlameNode[] = [];
    if (depth < FLAME_MAX_DEPTH) {
      for (const childId of node.children ?? []) {
        const child = byId.get(childId);
        if (child === undefined || child.callFrame.functionName === IDLE)
          continue;
        if (placed.has(childId)) continue;
        if ((total.get(childId) ?? 0) < minSamples) continue;
        children.push(toFlame(child, depth + 1));
      }
      children.sort((a, b) => b.totalSamples - a.totalSamples);
    }
    return {
      functionName: displayName(frame.functionName),
      url: frame.url,
      line: frame.lineNumber >= 0 ? frame.lineNumber + 1 : 0,
      selfSamples: self.get(node.id) ?? 0,
      totalSamples: total.get(node.id) ?? 0,
      children,
    };
  };
  const flame = toFlame(root, 0);
  // The root's width is what the graph shows: everything but idle time.
  const idle = (root.children ?? [])
    .map((id) => byId.get(id))
    .filter((n) => n?.callFrame.functionName === IDLE)
    .reduce((sum, n) => sum + (total.get((n as ProfileNode).id) ?? 0), 0);
  flame.totalSamples = Math.max(0, flame.totalSamples - idle);

  return {
    json: JSON.stringify(profile),
    samples: sampleCount,
    actualDurationMs: Math.max(0, (profile.endTime - profile.startTime) / 1000),
    topFunctions,
    flame,
  };
}
