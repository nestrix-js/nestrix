// Helpers for the store-*.test.ts files. Not a test file itself.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

let nextId = 1;

/** A 16-hex-digit span id, unique within the test file. */
export function spanId(): string {
  return (nextId++).toString(16).padStart(16, "0");
}

/** A 32-hex-digit trace id from a small number. */
export function traceId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function hr(ms: number): [number, number] {
  return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];
}

export interface FakeSpanInit {
  trace: number;
  id?: string;
  parent?: { spanId: string; isRemote?: boolean };
  name?: string;
  /** SpanKind as a number: 0 internal, 1 server, 2 client. */
  kind?: number;
  startMs?: number;
  durationMs?: number;
  attributes?: Record<string, unknown>;
  events?: {
    name: string;
    timeMs?: number;
    attributes?: Record<string, unknown>;
  }[];
  status?: { code: number; message?: string };
  scope?: string;
  resource?: Record<string, unknown>;
}

/** A structural `ReadableSpan`, as any copy of SDK 3 produces after `end()`. */
export function fakeSpan(init: FakeSpanInit): ReadableSpan {
  const id = init.id ?? spanId();
  const start = init.startMs ?? 1_700_000_000_000;
  const duration = init.durationMs ?? 5;
  const context = { traceId: traceId(init.trace), spanId: id, traceFlags: 1 };
  return {
    name: init.name ?? "span",
    kind: init.kind ?? 0,
    spanContext: () => context,
    parentSpanContext: init.parent
      ? {
          traceId: traceId(init.trace),
          spanId: init.parent.spanId,
          traceFlags: 1,
          isRemote: init.parent.isRemote ?? false,
        }
      : undefined,
    startTime: hr(start),
    endTime: hr(start + duration),
    duration: hr(duration),
    status: init.status ?? { code: 0 },
    attributes: (init.attributes ?? {}) as ReadableSpan["attributes"],
    links: [],
    events: (init.events ?? []).map((e) => ({
      name: e.name,
      time: hr(e.timeMs ?? start + 1),
      attributes: (e.attributes ?? {}) as ReadableSpan["attributes"],
    })),
    ended: true,
    resource: {
      attributes: init.resource ?? { "service.name": "store-test" },
    } as unknown as ReadableSpan["resource"],
    instrumentationScope: { name: init.scope ?? "@nestrix-js/nestjs" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** A server span that is the root of its trace (no parent). */
export function serverRoot(
  trace: number,
  extra: Partial<FakeSpanInit> = {},
): ReadableSpan {
  return fakeSpan({
    trace,
    name: "GET /items/:id",
    kind: 1,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/items/:id",
      "http.response.status_code": 200,
    },
    ...extra,
  });
}
