// A stub OTLP/HTTP JSON receiver for the metrics tests. Not a test file itself.
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReceivedPost {
  path: string;
  headers: IncomingHttpHeaders;
  body: OtlpMetricsBody;
}

interface OtlpKeyValue {
  key: string;
  value: Record<string, unknown>;
}

interface OtlpDataPoint {
  attributes?: OtlpKeyValue[];
  count?: string | number;
  asDouble?: number;
  asInt?: string | number;
}

interface OtlpMetric {
  name: string;
  unit?: string;
  histogram?: { dataPoints: OtlpDataPoint[] };
  gauge?: { dataPoints: OtlpDataPoint[] };
  sum?: { dataPoints: OtlpDataPoint[] };
}

interface OtlpMetricsBody {
  resourceMetrics?: {
    resource?: { attributes?: OtlpKeyValue[] };
    scopeMetrics?: { scope?: { name?: string }; metrics?: OtlpMetric[] }[];
  }[];
}

export function attrs(
  list: OtlpKeyValue[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) {
    const v = kv.value;
    out[kv.key] =
      "stringValue" in v
        ? v.stringValue
        : "intValue" in v
          ? Number(v.intValue)
          : "doubleValue" in v
            ? v.doubleValue
            : "boolValue" in v
              ? v.boolValue
              : v;
  }
  return out;
}

export interface MetricsReceiver {
  /** Base URL, no trailing slash. */
  base: string;
  posts: ReceivedPost[];
  /** When set, `/v1/metrics` requests are held open and never answered. */
  hang: boolean;
  metricPosts(): ReceivedPost[];
  close(): Promise<void>;
}

export async function startMetricsReceiver(): Promise<MetricsReceiver> {
  const receiver = {
    base: "",
    posts: [],
    hang: false,
  } as unknown as MetricsReceiver;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      if (path.includes("metrics")) {
        receiver.posts.push({
          path,
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        if (receiver.hang) return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  receiver.base = `http://127.0.0.1:${port}`;
  receiver.metricPosts = () =>
    receiver.posts.filter((p) => p.path.includes("metrics"));
  receiver.close = async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  };
  return receiver;
}

/** Every metric across the posts, flattened. */
export function receivedMetrics(posts: ReceivedPost[]): {
  name: string;
  unit: string | undefined;
  scope: string | undefined;
  resource: Record<string, unknown>;
  points: { attributes: Record<string, unknown>; count?: number }[];
}[] {
  const out = [];
  for (const post of posts) {
    for (const rm of post.body.resourceMetrics ?? []) {
      const resource = attrs(rm.resource?.attributes);
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          const dps =
            m.histogram?.dataPoints ??
            m.gauge?.dataPoints ??
            m.sum?.dataPoints ??
            [];
          out.push({
            name: m.name,
            unit: m.unit,
            scope: sm.scope?.name,
            resource,
            points: dps.map((dp) => ({
              attributes: attrs(dp.attributes),
              ...(dp.count !== undefined ? { count: Number(dp.count) } : {}),
            })),
          });
        }
      }
    }
  }
  return out;
}

/** Highest cumulative count seen for the request histogram point whose route is `route`. */
export function requestCount(posts: ReceivedPost[], route: string): number {
  let max = 0;
  for (const m of receivedMetrics(posts)) {
    if (m.name !== "http.server.request.duration") continue;
    for (const p of m.points) {
      if (p.attributes["http.route"] === route)
        max = Math.max(max, p.count ?? 0);
    }
  }
  return max;
}
