/**
 * The app map (D-56, P3-05): the app and what it calls, built from the traces in the store.
 *
 * Every client or producer span becomes a call from the app to a target: a database, a cache,
 * an HTTP host, a queue, or `other`. It reflects sampling, since the store holds only sampled
 * traces. Pure apart from reading the store; never throws.
 */
import type {
  AppMapResponse,
  Attributes,
  MapEdge,
  MapNode,
  MapNodeKind,
  SpanRecord,
} from "./protocol-types.js";
import type { TraceStore } from "./store.js";

/** Nodes in one response, the app included; targets past it fold into one `other` node. */
export const MAX_MAP_NODES = 200;
const APP_ID = "app";
const OVERFLOW_ID = "other:overflow";
const CACHE_SYSTEMS = new Set(["redis", "valkey", "memcached"]);
const DEFAULT_PORTS = new Set(["80", "443"]);

interface Target {
  node: MapNode;
  calls: number;
  errors: number;
  durations: number[];
}

function str(attributes: Attributes, key: string): string | undefined {
  const v = attributes[key];
  if (typeof v === "string") return v === "" ? undefined : v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function hostOfUrl(full: string | undefined): {
  address?: string;
  port?: string;
} {
  if (full === undefined) return {};
  try {
    const u = new URL(full);
    return u.port === ""
      ? { address: u.hostname }
      : { address: u.hostname, port: u.port };
  } catch {
    return {};
  }
}

/** The node a client or producer span calls, or `undefined` for a span that is not one. */
export function targetOf(span: SpanRecord): MapNode | undefined {
  if (span.kind !== "client" && span.kind !== "producer") return undefined;
  const a = span.attributes;
  const dbSystem = str(a, "db.system.name") ?? str(a, "db.system");
  if (dbSystem !== undefined) {
    const address = str(a, "server.address");
    const port = str(a, "server.port");
    const namespace = str(a, "db.namespace") ?? str(a, "db.name");
    const host =
      address === undefined
        ? ""
        : port === undefined
          ? address
          : `${address}:${port}`;
    const kind: MapNodeKind = CACHE_SYSTEMS.has(dbSystem.toLowerCase())
      ? "cache"
      : "database";
    const suffix = namespace === undefined ? "" : `/${namespace}`;
    return {
      id: `${kind === "cache" ? "cache" : "db"}:${dbSystem}:${host}${suffix}`,
      kind,
      name: namespace === undefined ? dbSystem : `${dbSystem} ${namespace}`,
      system: dbSystem,
    };
  }
  const messaging = str(a, "messaging.system");
  if (messaging !== undefined) {
    const destination = str(a, "messaging.destination.name");
    return {
      id: `queue:${messaging}:${destination ?? ""}`,
      kind: "queue",
      name: destination === undefined ? messaging : `queue ${destination}`,
      system: messaging,
    };
  }
  const isHttp =
    str(a, "http.request.method") !== undefined ||
    str(a, "http.method") !== undefined ||
    str(a, "url.full") !== undefined;
  const fromUrl = hostOfUrl(str(a, "url.full"));
  const address = str(a, "server.address") ?? fromUrl.address;
  const port = str(a, "server.port") ?? fromUrl.port;
  if (isHttp && address !== undefined) {
    const shown =
      port === undefined || DEFAULT_PORTS.has(port)
        ? address
        : `${address}:${port}`;
    return { id: `http:${shown}`, kind: "http", name: shown, system: "http" };
  }
  if (address !== undefined) {
    return { id: `other:${address}`, kind: "other", name: address };
  }
  return { id: "other:unknown", kind: "other", name: "other" };
}

/** Nearest-rank percentile of an ascending array. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

function edgeOf(t: Target): MapEdge {
  const sorted = t.durations.slice().sort((a, b) => a - b);
  return {
    from: APP_ID,
    to: t.node.id,
    calls: t.calls,
    errors: t.errors,
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
  };
}

function byCallsThenId(a: Target, b: Target): number {
  return b.calls - a.calls || (a.node.id < b.node.id ? -1 : 1);
}

export function buildAppMap(
  store: TraceStore | undefined,
  windowMinutes: number,
  now: number,
  serviceName?: string,
): AppMapResponse {
  const from = now - windowMinutes * 60_000;
  const targets = new Map<string, Target>();
  let appName: string | undefined;
  try {
    store?.scanTraces(from, (root, spans, resource) => {
      if (root.startTimeUnixMs > now) return;
      const name = resource["service.name"];
      if (typeof name === "string" && name !== "") appName = name;
      for (const span of spans) {
        const node = targetOf(span);
        if (node === undefined) continue;
        let t = targets.get(node.id);
        if (t === undefined) {
          t = { node, calls: 0, errors: 0, durations: [] };
          targets.set(node.id, t);
        }
        t.calls++;
        if (span.status.code === "error") t.errors++;
        t.durations.push(span.durationMs);
      }
    });
  } catch {
    // Answer with what was gathered.
  }
  const app: MapNode = {
    id: APP_ID,
    kind: "app",
    name: serviceName ?? appName ?? "app",
  };
  let kept = [...targets.values()].sort(byCallsThenId);
  if (kept.length > MAX_MAP_NODES - 1) {
    const rest = kept.slice(MAX_MAP_NODES - 2);
    kept = kept.slice(0, MAX_MAP_NODES - 2);
    const overflow: Target = {
      node: { id: OVERFLOW_ID, kind: "other", name: "other (more targets)" },
      calls: 0,
      errors: 0,
      durations: [],
    };
    for (const t of rest) {
      overflow.calls += t.calls;
      overflow.errors += t.errors;
      for (const d of t.durations) overflow.durations.push(d);
    }
    kept.push(overflow);
    kept.sort(byCallsThenId);
  }
  return {
    windowMinutes,
    fromUnixMs: from,
    toUnixMs: now,
    nodes: [app, ...kept.map((t) => t.node)],
    edges: kept.map(edgeOf),
  };
}
