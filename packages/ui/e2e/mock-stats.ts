// Error list and route statistics for the mock API: cursor semantics like the trace list,
// and statistics generated for any window. Not the P2-03/P2-04 code.
import type {
  ErrorItem,
  ErrorListResponse,
  RouteStats,
  RouteStatsResponse,
} from "@nestrix-js/protocol";

const ERROR_ROUTES = ["/orders", "/orders/:id", "/users"];
const ERROR_TYPES = ["BadGatewayException", "TimeoutError", "TypeError"];

interface Stored extends ErrorItem {
  seq: number;
}

export class ErrorStore {
  private items: Stored[] = []; // newest first
  private seq = 0;
  /** After-polls repeat the item at the cursor too, as a retry or race could. */
  overlap = false;
  /** When set, every answer is this response verbatim (the protocol fixture). */
  fixed: ErrorListResponse | null = null;

  constructor(private epoch: () => number) {}

  reset(count: number): void {
    this.items = [];
    this.seq = 0;
    this.overlap = false;
    this.fixed = null;
    this.push(count);
  }

  get size(): number {
    return this.items.length;
  }

  /** Errors with the id `seq` as in `errorId(seq)`; routes cycle, types cycle. */
  push(count: number): void {
    for (let i = 0; i < count; i++) {
      const seq = ++this.seq;
      const route = ERROR_ROUTES[seq % ERROR_ROUTES.length] as string;
      this.items.unshift({
        seq,
        traceId: seq.toString(16).padStart(32, "0"),
        spanId: seq.toString(16).padStart(16, "0"),
        spanName: `GET ${route}`,
        spanKind: "server",
        route,
        method: "GET",
        statusCode: 500,
        errorType: ERROR_TYPES[seq % ERROR_TYPES.length],
        message: `Error number ${seq}${seq % 4 === 0 ? ` ${"and a long explanation ".repeat(12)}end` : ""}`,
        timeUnixMs: Date.now() - 1000 + seq,
        cursor: `e${this.epoch()}.${seq}`,
      });
    }
  }

  private parse(
    cursor: string | null,
  ): { epoch: number; seq: number } | "bad" | null {
    if (cursor === null) return null;
    const m = /^e(\d+)\.(\d+)$/.exec(cursor);
    return m ? { epoch: Number(m[1]), seq: Number(m[2]) } : "bad";
  }

  answer(q: URLSearchParams): { status: number; body: unknown } {
    if (this.fixed) return { status: 200, body: this.fixed };
    for (const key of q.keys())
      if (!["limit", "before", "after", "route", "service"].includes(key))
        return {
          status: 400,
          body: {
            error: { code: "bad_request", message: `Unknown parameter ${key}` },
          },
        };
    const limit = Number(q.get("limit") ?? 50);
    const before = this.parse(q.get("before"));
    const after = this.parse(q.get("after"));
    const cursor = before ?? after;
    const stale =
      cursor === "bad" || (cursor !== null && cursor.epoch !== this.epoch());
    const route = q.get("route");
    const filtered = this.items.filter((i) => !route || i.route === route);
    let pool = filtered;
    if (!stale && before && before !== "bad")
      pool = filtered.filter((i) => i.seq < before.seq);
    if (!stale && after && after !== "bad") {
      const from = this.overlap ? after.seq : after.seq + 1;
      pool = filtered.filter((i) => i.seq >= from);
    }
    const page = pool.slice(0, limit);
    const last = page.at(-1);
    const body: ErrorListResponse = {
      head: this.items[0]?.cursor ?? null,
      older:
        last !== undefined && filtered.some((i) => i.seq < last.seq)
          ? last.cursor
          : null,
      reset: stale,
      items: page.map(({ seq: _seq, ...item }) => item),
    };
    return { status: 200, body };
  }
}

/**
 * One point per minute over `windowMinutes`, for three routes: a busy one with errors, a
 * quiet one with gaps, and `(unmatched)`. Values are a function of the minute, so a test can
 * tell windows apart by the number of points.
 */
export function generatedRoutes(windowMinutes: number): RouteStatsResponse {
  const bucketMs = 60_000;
  const to = Math.floor(Date.now() / bucketMs) * bucketMs;
  const from = to - windowMinutes * bucketMs;
  const make = (
    method: string,
    route: string,
    perMinute: number,
    errorEvery: number,
    gaps: boolean,
  ): RouteStats => {
    const series = Array.from({ length: windowMinutes }, (_, i) => {
      const count = gaps && i % 3 === 0 ? 0 : perMinute + (i % 4);
      const errors = errorEvery > 0 && i % errorEvery === 0 ? 1 : 0;
      return {
        timeUnixMs: from + i * bucketMs,
        count,
        errors: count === 0 ? 0 : errors,
        ...(count === 0
          ? {}
          : { p50Ms: 10 + (i % 5), p95Ms: 40 + (i % 7) * 3 }),
      };
    });
    const count = series.reduce((n, p) => n + p.count, 0);
    return {
      method,
      route,
      count,
      errors: series.reduce((n, p) => n + p.errors, 0),
      p50Ms: 12,
      p95Ms: 52,
      p99Ms: 80,
      maxMs: 120,
      series,
    };
  };
  return {
    windowMinutes,
    bucketMs,
    fromUnixMs: from,
    toUnixMs: to,
    routes: [
      make("GET", "/orders/:id", 20, 5, false),
      make("POST", "/orders", 4, 0, true),
      make("GET", "(unmatched)", 1, 2, false),
      { ...make("*", "(other)", 0, 0, true), count: 1, errors: 0 },
    ],
  };
}
