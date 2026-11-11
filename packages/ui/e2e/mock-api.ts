// An in-memory stand-in for the Nestrix query API (docs/backlog/phase-2.md "Public API"),
// with the cursor semantics the UI depends on and switches the tests flip: new items,
// overlapping polls, a new epoch (`reset`), failures and delays. Not the P2-03 store.

import type {
  MetaResponse,
  RouteStatsResponse,
  TraceListResponse,
  TraceResponse,
  TraceSummary,
} from "@nestrix/protocol";
import { ErrorStore } from "./mock-stats.ts";

type Endpoint = "meta" | "traces" | "routes" | "errors";

const ROUTES = ["/orders", "/orders/:id", "/users", "/health"];
const METHODS = ["GET", "POST", "GET", "PUT"];

interface Item extends TraceSummary {
  seq: number;
}

export class MockApi {
  epoch = 1;
  sampling: MetaResponse["sampling"] = { owner: "nestrix", rate: 0.25 };
  /** Endpoints answering 500. */
  failing = new Set<Endpoint>();
  /** Milliseconds every traces answer is held back. */
  delayMs = 0;
  /** After-polls repeat the item at the cursor too, as a retry or race could. */
  overlap = false;
  /** Error list store; empty until a test pushes into it. */
  errors = new ErrorStore(() => this.epoch);
  /** When set, `routes` answers with this for the asked window instead of the stub. */
  routeStats: ((windowMinutes: number) => RouteStatsResponse) | null = null;
  /** Every request seen, `traces?after=...` and so on, in order. */
  requests: string[] = [];
  private items: Item[] = []; // newest first
  private seq = 0;

  constructor() {
    this.reset(0);
  }

  /** Back to a clean store of `count` items; a new epoch invalidates held cursors. */
  reset(count = 120): void {
    this.epoch += 1;
    this.items = [];
    this.seq = 0;
    this.sampling = { owner: "nestrix", rate: 0.25 };
    this.failing.clear();
    this.delayMs = 0;
    this.overlap = false;
    this.requests = [];
    this.routeStats = null;
    this.errors.reset(0);
    this.push(count);
  }

  /** Replaces the store as a restarted process would: same cursor shape, new epoch. */
  restart(count: number): void {
    this.epoch += 1;
    this.items = [];
    this.seq = 0;
    this.push(count);
  }

  push(count: number): void {
    for (let i = 0; i < count; i++) {
      const seq = ++this.seq;
      const route = ROUTES[seq % ROUTES.length] as string;
      const method = METHODS[seq % METHODS.length] as string;
      const statusCode = seq % 5 === 0 ? 500 : seq % 7 === 0 ? 404 : 200;
      this.items.unshift({
        seq,
        traceId: seq.toString(16).padStart(32, "0"),
        rootSpanId: seq.toString(16).padStart(16, "0"),
        name: `${method} ${route}`,
        method,
        route,
        statusCode,
        error: statusCode >= 500,
        startTimeUnixMs: Date.now() - 1000 + seq,
        durationMs: 5 + ((seq * 7) % 300),
        spanCount: 1 + (seq % 5),
        cursor: this.cursor(seq),
      });
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** Requests to `traces` carrying the given parameter, as parsed query strings. */
  traceRequests(): URLSearchParams[] {
    return this.requests
      .filter((r) => r.startsWith("traces"))
      .map((r) => new URLSearchParams(r.split("?")[1] ?? ""));
  }

  private cursor(seq: number): string {
    return `c${this.epoch}.${seq}`;
  }

  private parse(
    cursor: string | null,
  ): { epoch: number; seq: number } | "bad" | null {
    if (cursor === null) return null;
    const m = /^c(\d+)\.(\d+)$/.exec(cursor);
    return m ? { epoch: Number(m[1]), seq: Number(m[2]) } : "bad";
  }

  /** Answers one API request: `endpoint` is the path after `api/v1/`. */
  async handle(
    endpoint: string,
    query: URLSearchParams,
  ): Promise<{ status: number; body: unknown }> {
    this.requests.push(`${endpoint}${query.size > 0 ? `?${query}` : ""}`);
    if (endpoint === "traces" && this.delayMs > 0)
      await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failing.has(endpoint as Endpoint))
      return {
        status: 500,
        body: { error: { code: "internal", message: "Mock failure" } },
      };
    switch (endpoint) {
      case "meta":
        return { status: 200, body: this.meta() };
      case "routes":
        return { status: 200, body: this.routes(query) };
      case "traces":
        return this.traces(query);
      case "trace":
        return this.trace(query.get("id"));
      case "errors":
        return this.errors.answer(query);
      default:
        return {
          status: 404,
          body: { error: { code: "not_found", message: "Not found" } },
        };
    }
  }

  private meta(): MetaResponse {
    return {
      protocolVersion: 1,
      processId: `p${this.epoch}`,
      serverTimeUnixMs: Date.now(),
      service: { name: "demo-service" },
      sampling: this.sampling,
      store: {
        traces: this.items.length,
        spans: this.items.length * 3,
        bytes: 0,
        maxTraces: 1000,
        maxBytes: 1_000_000,
        evictedTraces: 0,
        droppedSpans: 0,
      },
      statistics: { sinceUnixMs: 0, windowsMinutes: [15, 60] },
      warnings: [],
    };
  }

  private routes(query: URLSearchParams): RouteStatsResponse {
    if (this.routeStats)
      return this.routeStats(Number(query.get("windowMinutes") ?? 15));
    return {
      windowMinutes: 15,
      bucketMs: 60_000,
      fromUnixMs: 0,
      toUnixMs: 0,
      routes: ROUTES.map((route) => ({
        method: "GET",
        route,
        count: 1,
        errors: 0,
        p50Ms: 1,
        p95Ms: 1,
        p99Ms: 1,
        maxMs: 1,
        series: [],
      })),
    };
  }

  /** A stored trace: the item's root span with a guard and a handler child; 404 for an unknown id. */
  private trace(id: string | null): { status: number; body: unknown } {
    const item = this.items.find((i) => i.traceId === id);
    if (!item)
      return {
        status: 404,
        body: { error: { code: "not_found", message: "Trace not found" } },
      };
    const child = (n: number, name: string, offset: number, share: number) => ({
      spanId: `${item.rootSpanId.slice(0, 15)}${n}`,
      parentSpanId: item.rootSpanId,
      name,
      kind: "internal" as const,
      startTimeUnixMs: item.startTimeUnixMs + offset,
      durationMs: item.durationMs * share,
      attributes: {},
      events: [],
      status: { code: "unset" as const },
      links: [],
    });
    const body: TraceResponse = {
      traceId: item.traceId,
      rootSpanId: item.rootSpanId,
      resource: { "service.name": "demo-service" },
      spans: [
        {
          spanId: item.rootSpanId,
          name: item.name,
          kind: "server",
          startTimeUnixMs: item.startTimeUnixMs,
          durationMs: item.durationMs,
          attributes: {
            "http.request.method": item.method ?? "GET",
            "http.route": item.route ?? "/",
            "http.response.status_code": item.statusCode ?? 200,
          },
          events: [],
          status: { code: item.error ? "error" : "unset" },
          links: [],
        },
        child(1, "guard", 0.1, 0.1),
        child(2, "handler", item.durationMs * 0.2, 0.7),
      ],
    };
    return { status: 200, body };
  }

  private matches(item: Item, q: URLSearchParams): boolean {
    const status = q.get("status");
    const code = item.statusCode ?? 0;
    const search = (q.get("search") ?? "").toLowerCase();
    return (
      (!q.get("route") || item.route === q.get("route")) &&
      (!q.get("method") || item.method === q.get("method")) &&
      (!status ||
        (status === "error" && item.error) ||
        (status === "ok" && !item.error) ||
        (status === "4xx" && code >= 400 && code < 500) ||
        (status === "5xx" && code >= 500)) &&
      item.durationMs >= Number(q.get("minDurationMs") ?? 0) &&
      (!search ||
        item.name.toLowerCase().includes(search) ||
        (item.route ?? "").toLowerCase().includes(search))
    );
  }

  private traces(q: URLSearchParams): { status: number; body: unknown } {
    const known = new Set([
      "limit",
      "before",
      "after",
      "route",
      "method",
      "status",
      "minDurationMs",
      "search",
    ]);
    for (const key of q.keys())
      if (!known.has(key))
        return {
          status: 400,
          body: {
            error: { code: "bad_request", message: `Unknown parameter ${key}` },
          },
        };
    if (q.has("before") && q.has("after"))
      return {
        status: 400,
        body: { error: { code: "bad_request", message: "before and after" } },
      };
    const limit = Number(q.get("limit") ?? 50);
    const before = this.parse(q.get("before"));
    const after = this.parse(q.get("after"));
    const cursor = before ?? after;
    const stale =
      cursor === "bad" || (cursor !== null && cursor.epoch !== this.epoch);

    const filtered = this.items.filter((i) => this.matches(i, q));
    let pool = filtered;
    if (!stale && before && before !== "bad")
      pool = filtered.filter((i) => i.seq < before.seq);
    if (!stale && after && after !== "bad") {
      const from = this.overlap ? after.seq : after.seq + 1;
      pool = filtered.filter((i) => i.seq >= from);
    }
    // `after` pages are the newest items; `before` and first pages start at the newest of the pool.
    const page = pool.slice(0, limit);
    const last = page.at(-1);
    const hasOlder =
      last !== undefined && filtered.some((i) => i.seq < last.seq);
    const body: TraceListResponse = {
      head: this.items[0]?.cursor ?? null,
      older: hasOlder && last ? last.cursor : null,
      reset: stale,
      items: page.map(({ seq: _seq, ...summary }) => summary),
    };
    return { status: 200, body };
  }
}
