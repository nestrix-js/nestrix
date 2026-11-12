/**
 * Reading an uploaded `.cpuprofile` (P10-02). The body comes from an app instance holding an
 * ingest key, so it is untrusted: it is checked field by field and rebuilt from the known fields
 * only (unknown fields are dropped, strings are cut), before the shared summary code
 * (`normalize.ts`) runs on it. Pure functions; `readCpuProfile` never throws.
 */

/** Longest `functionName` or `url` kept; longer ones are cut. */
export const MAX_FRAME_STRING = 2048;
/** Nodes accepted in one profile. */
export const MAX_NODES = 1_000_000;

interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface PositionTick {
  line: number;
  ticks: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
  positionTicks?: PositionTick[];
}

/** The shape `normalize.ts` and Chrome DevTools read. */
export interface CleanCpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export type CpuProfileResult =
  | { ok: true; profile: CleanCpuProfile }
  | { ok: false; message: string };

class Invalid extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function int(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Invalid(`${what} must be a whole number`);
  }
  return value;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Invalid(`${what} must be a number`);
  }
  return value;
}

function text(value: unknown, what: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Invalid(`${what} must be a string`);
  return value.length > MAX_FRAME_STRING
    ? value.slice(0, MAX_FRAME_STRING)
    : value;
}

function intArray(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) throw new Invalid(`${what} must be an array`);
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number" || !Number.isSafeInteger(value[i])) {
      throw new Invalid(`${what} must hold whole numbers`);
    }
  }
  return value as number[];
}

function readNode(raw: unknown): ProfileNode {
  if (!isObject(raw)) throw new Invalid("each node must be an object");
  const frame = raw.callFrame;
  if (!isObject(frame)) throw new Invalid("each node needs a callFrame");
  const scriptId = frame.scriptId;
  if (
    scriptId !== undefined &&
    typeof scriptId !== "string" &&
    !(typeof scriptId === "number" && Number.isSafeInteger(scriptId))
  ) {
    throw new Invalid("callFrame.scriptId must be a string or a number");
  }
  const node: ProfileNode = {
    id: int(raw.id, "node id"),
    callFrame: {
      functionName: text(frame.functionName, "callFrame.functionName"),
      scriptId: String(scriptId ?? "0").slice(0, 64),
      url: text(frame.url, "callFrame.url"),
      lineNumber:
        frame.lineNumber === undefined
          ? -1
          : int(frame.lineNumber, "callFrame.lineNumber"),
      columnNumber:
        frame.columnNumber === undefined
          ? -1
          : int(frame.columnNumber, "callFrame.columnNumber"),
    },
  };
  if (raw.hitCount !== undefined) node.hitCount = int(raw.hitCount, "hitCount");
  if (raw.children !== undefined)
    node.children = intArray(raw.children, "children");
  if (raw.positionTicks !== undefined) {
    if (!Array.isArray(raw.positionTicks)) {
      throw new Invalid("positionTicks must be an array");
    }
    node.positionTicks = raw.positionTicks.map((t: unknown) => {
      if (!isObject(t))
        throw new Invalid("each positionTick must be an object");
      return {
        line: int(t.line, "positionTick line"),
        ticks: int(t.ticks, "positionTick ticks"),
      };
    });
  }
  return node;
}

/**
 * Checks a parsed upload and rebuilds it from the known fields: `nodes` (unique integer ids, a
 * `callFrame` each, children that name existing nodes), `samples` (ids of existing nodes),
 * `timeDeltas` (as many numbers as samples), numeric `startTime` and `endTime` (end not before
 * start). Never throws.
 */
export function readCpuProfile(value: unknown): CpuProfileResult {
  try {
    if (!isObject(value))
      throw new Invalid("the profile must be a JSON object");
    if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
      throw new Invalid("nodes must be a non-empty array");
    }
    if (value.nodes.length > MAX_NODES) {
      throw new Invalid(`a profile may have at most ${MAX_NODES} nodes`);
    }
    const nodes = value.nodes.map(readNode);
    const ids = new Set<number>();
    for (const node of nodes) {
      if (ids.has(node.id)) throw new Invalid("node ids must be unique");
      ids.add(node.id);
    }
    for (const node of nodes) {
      for (const child of node.children ?? []) {
        if (!ids.has(child)) throw new Invalid("a child names no node");
      }
    }
    const samples = intArray(value.samples, "samples");
    for (const id of samples) {
      if (!ids.has(id)) throw new Invalid("a sample names no node");
    }
    if (!Array.isArray(value.timeDeltas)) {
      throw new Invalid("timeDeltas must be an array");
    }
    const timeDeltas = value.timeDeltas.map((d: unknown) =>
      finite(d, "timeDeltas"),
    );
    if (timeDeltas.length !== samples.length) {
      throw new Invalid("timeDeltas must have one entry per sample");
    }
    const startTime = finite(value.startTime, "startTime");
    const endTime = finite(value.endTime, "endTime");
    if (endTime < startTime) {
      throw new Invalid("endTime must not be before startTime");
    }
    return {
      ok: true,
      profile: { nodes, startTime, endTime, samples, timeDeltas },
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Invalid
          ? `not a CPU profile: ${error.message}`
          : "not a CPU profile",
    };
  }
}
