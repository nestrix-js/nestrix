/**
 * The node a client or producer span calls, by the same rules as the embedded app map
 * (`packages/nestjs/src/store/app-map.ts`, `targetOf`; copied because it is not public API of
 * `@nestrix/nestjs`). The query groups spans by the attributes named in {@link TARGET_KEYS}, so
 * only those matter here; `url.full` is reduced to `scheme://authority` in SQL (its path and
 * query would make every request its own group, and only the host and port are read from it).
 */
import type { MapNode, MapNodeKind } from "@nestrix/protocol";

/** Attribute keys `targetOf` reads. */
export const TARGET_KEYS = [
  "db.system.name",
  "db.system",
  "server.address",
  "server.port",
  "db.namespace",
  "db.name",
  "messaging.system",
  "messaging.destination.name",
  "http.request.method",
  "http.method",
  "url.full",
] as const;

type Attrs = Readonly<Record<string, unknown>>;

const CACHE_SYSTEMS = new Set(["redis", "valkey", "memcached"]);
const DEFAULT_PORTS = new Set(["80", "443"]);

function str(attributes: Attrs, key: string): string | undefined {
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

export function targetOf(a: Attrs): MapNode {
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
