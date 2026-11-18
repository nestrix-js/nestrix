// D-111 (audit, "Protected headers remain visible on span events"): the built-in scrub rule
// applies to every span event's attributes, before the user's `redact` hook, in both sinks that
// take spans out of Nestrix: the dashboard store and the Nestrix-owned OTLP exporter.
// Global state in the last block: no host SDK; Nestrix owns the provider (OTLP export to a local
// receiver, dashboard on), one app at a time, on all three adapters.
import "reflect-metadata";
import { Controller, Get, Headers, Module, Query } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { recordError } from "../src/errors/record-error.js";
import { NestrixModule } from "../src/nestrix.module.js";
import type { RedactableSpan, RedactHook } from "../src/options.js";
import { createRedactingExporter } from "../src/otel/redacting-exporter.js";
import { buildRedactedQueryKeys, scrubSpanAttributes } from "../src/privacy.js";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import { BEARER, get, TOKEN } from "./dashboard-fixture.js";
import { ADAPTERS, bootInstrumented } from "./methods/helpers.js";
import {
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";
import { fakeSpan, traceId } from "./store-helpers.js";

const SECRET = "s3cr3t-value";

/** What application code or an instrumentation might put on an event. */
const LEAKY_EVENT_ATTRIBUTES = {
  "http.request.header.authorization": [`Bearer ${SECRET}`],
  "http.request.header.cookie": [`sid=${SECRET}`],
  "url.full": `https://user:${SECRET}@api.example.com/cb?token=${SECRET}&page=2#frag`,
  "app.kept": "visible",
};

const SCRUBBED_EVENT_ATTRIBUTES = {
  "http.request.header.authorization": ["REDACTED"],
  "http.request.header.cookie": ["REDACTED"],
  "url.full":
    "https://REDACTED:REDACTED@api.example.com/cb?token=REDACTED&page=2",
  "app.kept": "visible",
};

function leakySpan(n: number, name = "GET /cb"): ReadableSpan {
  return fakeSpan({
    trace: n,
    name,
    kind: 1,
    attributes: { "http.request.method": "GET" },
    events: [
      { name: "app.event", attributes: { ...LEAKY_EVENT_ATTRIBUTES } },
      {
        name: "exception",
        attributes: {
          "exception.type": "Error",
          "exception.message": "boom",
          "http.response.header.set-cookie": [`a=${SECRET}`],
        },
      },
    ],
  });
}

function counters() {
  return {
    exportedSpans: 0,
    exportFailedSpans: 0,
    redactDroppedSpans: 0,
    redactFailedSpans: 0,
  };
}

function capturingExporter() {
  const exported: ReadableSpan[] = [];
  const inner: SpanExporter = {
    export(spans, done) {
      exported.push(...spans);
      done({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
  return { exported, inner };
}

const builtInScrub = (() => {
  const keys = buildRedactedQueryKeys();
  return (span: RedactableSpan) => scrubSpanAttributes(span, keys);
})();

describe("owned exporter: event attributes", () => {
  it("masks protected headers and redacted query keys on every exported event", () => {
    const { exported, inner } = capturingExporter();
    const d = recordingDiagnostics();
    const exporter = createRedactingExporter(inner, {
      scrub: builtInScrub,
      redact: undefined,
      counters: counters(),
      diagnostics: d,
    });
    exporter.export([leakySpan(1)], () => {});
    expect(exported).toHaveLength(1);
    const events = exported[0]?.events ?? [];
    expect(events[0]?.attributes).toEqual(SCRUBBED_EVENT_ATTRIBUTES);
    expect(events[1]?.attributes).toMatchObject({
      "exception.message": "boom",
      "http.response.header.set-cookie": ["REDACTED"],
    });
    expect(JSON.stringify(exported[0]?.events)).not.toContain(SECRET);
  });

  it("the user's redact hook sees the scrubbed event and can change it further", () => {
    const { exported, inner } = capturingExporter();
    const seen: unknown[] = [];
    const redact: RedactHook = (span) => {
      const event = span.events[0];
      seen.push(event?.attributes["http.request.header.authorization"]);
      if (event) {
        delete event.attributes["app.kept"];
        event.attributes["app.hook"] = "added";
      }
    };
    const exporter = createRedactingExporter(inner, {
      scrub: builtInScrub,
      redact,
      counters: counters(),
      diagnostics: recordingDiagnostics(),
    });
    exporter.export([leakySpan(1)], () => {});
    expect(seen).toEqual([["REDACTED"]]);
    expect(exported[0]?.events[0]?.attributes).toEqual({
      "http.request.header.authorization": ["REDACTED"],
      "http.request.header.cookie": ["REDACTED"],
      "url.full":
        "https://REDACTED:REDACTED@api.example.com/cb?token=REDACTED&page=2",
      "app.hook": "added",
    });
  });

  it("fails closed: an event map the scrub cannot neutralise drops the span, counted", () => {
    const { exported, inner } = capturingExporter();
    const c = counters();
    const d = recordingDiagnostics();
    const exporter = createRedactingExporter(inner, {
      // The built-in scrub on a view whose first event cannot be read or replaced.
      scrub: (span) => {
        if (span.name === "hostile") {
          Object.defineProperty(span.events[0], "attributes", {
            get() {
              throw new Error("event attributes fault");
            },
          });
        }
        builtInScrub(span);
      },
      redact: undefined,
      counters: c,
      diagnostics: d,
    });
    let result: number | undefined;
    expect(() =>
      exporter.export([leakySpan(1, "hostile"), leakySpan(2)], (r) => {
        result = r.code;
      }),
    ).not.toThrow();
    expect(result).toBe(ExportResultCode.SUCCESS);
    expect(exported.map((s) => s.name)).toEqual(["GET /cb"]);
    expect(c.redactFailedSpans).toBe(1);
    expect(d.failures.map((f) => f.where)).toEqual(["otel.redact"]);
  });

  it("fails closed when the scrub cannot read a value once and cannot delete it: event emptied, span dropped", () => {
    // A value that throws on its first read (the scrub's) and cannot be deleted: before D-111
    // the scrub swallowed that, and the validation step's second read let the raw value through.
    function onceThrowing(target: Record<string, unknown>, key: string) {
      let thrown = false;
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: false,
        get() {
          if (!thrown) {
            thrown = true;
            throw new Error("first read");
          }
          return `https://api.example.com/cb?token=${SECRET}`;
        },
      });
    }
    const { exported, inner } = capturingExporter();
    const c = counters();
    const exporter = createRedactingExporter(inner, {
      scrub: (span) => {
        if (span.name === "hostile-event" && span.events[0]) {
          onceThrowing(span.events[0].attributes, "url.full");
        }
        if (span.name === "hostile-span")
          onceThrowing(span.attributes, "url.full");
        builtInScrub(span);
      },
      redact: undefined,
      counters: c,
      diagnostics: recordingDiagnostics(),
    });
    exporter.export(
      [leakySpan(1, "hostile-event"), leakySpan(2, "hostile-span")],
      () => {},
    );
    expect(exported.map((s) => s.name)).toEqual(["hostile-event"]);
    expect(exported[0]?.events[0]?.attributes).toEqual({});
    expect(exported[0]?.events[1]?.attributes).toMatchObject({
      "http.response.header.set-cookie": ["REDACTED"],
    });
    expect(JSON.stringify(exported[0]?.events)).not.toContain(SECRET);
    expect(c.redactFailedSpans).toBe(1);
  });
});

describe("dashboard store: event attributes", () => {
  beforeEach(() => resetStoreForTests());
  afterEach(() => resetStoreForTests());

  it("masks them with the store's default scrub and with the attached built-in scrub", () => {
    for (const scrub of [undefined, builtInScrub]) {
      resetStoreForTests();
      const store = getOrCreateStore({}, recordingDiagnostics());
      store.attach({ scrub });
      const processor = createStoreProcessor(store);
      processor.onEnd(leakySpan(1));
      store.drainNow();
      const [span] = store.getTrace(traceId(1))?.spans ?? [];
      expect(span?.events[0]?.attributes).toEqual(SCRUBBED_EVENT_ATTRIBUTES);
      expect(span?.events[1]?.attributes).toMatchObject({
        "http.response.header.set-cookie": ["REDACTED"],
      });
      expect(JSON.stringify(span)).not.toContain(SECRET);
    }
  });

  it("the user's redact hook sees the scrubbed event; a hostile event drops only its span", () => {
    const d = recordingDiagnostics();
    const store = getOrCreateStore({}, d);
    const seen: unknown[] = [];
    store.attach({
      scrub: (span) => {
        if (span.name === "hostile") {
          Object.defineProperty(span.events[0], "attributes", {
            get() {
              throw new Error("event attributes fault");
            },
          });
        }
        builtInScrub(span);
      },
      redact: (span) => {
        seen.push(span.events[0]?.attributes["http.request.header.cookie"]);
        const event = span.events[0];
        if (event) event.attributes["url.full"] = "[hidden]";
      },
    });
    const processor = createStoreProcessor(store);
    processor.onEnd(leakySpan(1));
    processor.onEnd(leakySpan(2, "hostile"));
    store.drainNow();
    expect(seen).toEqual([["REDACTED"]]);
    const [span] = store.getTrace(traceId(1))?.spans ?? [];
    expect(span?.events[0]?.attributes["url.full"]).toBe("[hidden]");
    expect(
      span?.events[0]?.attributes["http.request.header.authorization"],
    ).toEqual(["REDACTED"]);
    expect(store.getTrace(traceId(2))).toBeUndefined();
    expect(store.stats().redactFailedSpans).toBe(1);
  });
});

// ---- a Nest app owning the provider: application code puts request credentials on events ----

@Controller("ev")
class EventsController {
  @Get()
  handle(
    @Headers("authorization") authorization: string,
    @Headers("cookie") cookie: string,
    @Query("token") token: string,
  ): string {
    const full = `http://127.0.0.1/ev?token=${token}&page=1`;
    trace.getActiveSpan()?.addEvent("app.checkpoint", {
      "http.request.header.authorization": [authorization],
      "http.request.header.cookie": [cookie],
      "url.full": full,
      "app.kept": "visible",
    });
    recordError(new Error("handled"), {
      "http.request.header.authorization": [authorization],
      "http.request.header.cookie": [cookie],
      "url.full": full,
      "app.kept": "visible",
    });
    return trace.getActiveSpan()?.spanContext().traceId ?? "";
  }
}

let receiver: Receiver;
beforeAll(async () => {
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver.close();
});

function appModule(redact?: RedactHook) {
  @Module({
    imports: [
      NestrixModule.forRoot({
        export: {
          otlp: { endpoint: receiver.url.replace(/\/v1\/traces$/, "") },
          queue: { scheduledDelayMillis: 20 },
        },
        ui: { enabled: true, auth: { token: TOKEN } },
        metrics: false,
        ...(redact ? { redact } : {}),
      }),
    ],
    controllers: [EventsController],
  })
  class EventsApp {}
  return EventsApp;
}

interface StoredTrace {
  spans: {
    name: string;
    events: { name: string; attributes: Record<string, unknown> }[];
  }[];
}

const EXPECTED_E2E = {
  "http.request.header.authorization": ["REDACTED"],
  "http.request.header.cookie": ["REDACTED"],
  "url.full": "http://127.0.0.1/ev?token=REDACTED&page=1",
};

describe.each(ADAPTERS)(
  "Nest app on %s, Nestrix owns the provider",
  (adapter) => {
    afterEach(() => {
      receiver.spans.length = 0;
      resetStoreForTests();
    });

    for (const withHook of [false, true]) {
      it(`event and recordError attributes are masked in the store and the export (redact hook ${withHook ? "on" : "off"})`, async () => {
        const hookSaw: unknown[] = [];
        const redact: RedactHook | undefined = withHook
          ? (span) => {
              for (const event of span.events) {
                if (event.attributes["app.kept"] === undefined) continue;
                hookSaw.push(
                  event.attributes["http.request.header.authorization"],
                );
                event.attributes["app.kept"] = "changed by hook";
              }
            }
          : undefined;
        const booted = await bootInstrumented(adapter, appModule(redact));
        let stored: StoredTrace | undefined;
        try {
          const res = await fetch(`${booted.baseUrl}/ev?token=${SECRET}`, {
            headers: {
              authorization: `Bearer ${SECRET}`,
              cookie: `sid=${SECRET}`,
            },
          });
          expect(res.status).toBe(200);
          const id = await res.text();
          expect(id).toMatch(/^[0-9a-f]{32}$/);
          for (let i = 0; i < 100 && stored === undefined; i++) {
            const r = await get(
              `${booted.baseUrl}/_nestrix/api/v1/trace?id=${id}`,
              BEARER,
            );
            if (r.status === 200) stored = r.json() as StoredTrace;
            else await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } finally {
          await booted.close();
        }
        const kept = withHook ? "changed by hook" : "visible";
        const storedEvents = (stored?.spans ?? []).flatMap((s) =>
          s.events.filter((e) => e.attributes["app.kept"] !== undefined),
        );
        expect(storedEvents.map((e) => e.name).sort()).toEqual([
          "app.checkpoint",
          "exception",
        ]);
        for (const e of storedEvents) {
          expect(e.attributes).toMatchObject({
            ...EXPECTED_E2E,
            "app.kept": kept,
          });
        }
        expect(JSON.stringify(stored)).not.toContain(SECRET);

        await receiver.waitForSpans(1);
        const exportedEvents = receiver.spans.flatMap((s) =>
          s.events.filter((e) => e.attributes["app.kept"] !== undefined),
        );
        expect(exportedEvents.map((e) => e.name).sort()).toEqual([
          "app.checkpoint",
          "exception",
        ]);
        for (const e of exportedEvents) {
          expect(e.attributes).toMatchObject({
            ...EXPECTED_E2E,
            "app.kept": kept,
          });
        }
        expect(JSON.stringify(receiver.spans)).not.toContain(SECRET);
        if (withHook) {
          // Store and exporter each run the hook once per span; it saw only scrubbed values.
          expect(hookSaw.length).toBeGreaterThanOrEqual(2);
          for (const v of hookSaw) expect(v).toEqual(["REDACTED"]);
        }
      });
    }
  },
);
