// P5-03: the embedded query API accepts the standalone server's `service` filter. It serves one
// application, so a `service` equal to its own name changes nothing and any other name answers
// empty results; `meta.mode` is `embedded`. No OpenTelemetry globals are touched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApiSources,
  appMapSpec,
  classesHandler,
  classStatsSpec,
  errorListSpec,
  errorsHandler,
  mapHandler,
  metaHandler,
  parseQuery,
  routeStatsSpec,
  routesHandler,
  traceListSpec,
  tracesHandler,
} from "../src/dashboard/api.js";
import { ClassStatistics } from "../src/stats/class-stats.js";
import { RouteStatistics } from "../src/stats/route-stats.js";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot } from "./store-helpers.js";

beforeEach(() => resetStoreForTests());
afterEach(() => resetStoreForTests());

const NOW = Date.now();

function sources(): ApiSources {
  const store = getOrCreateStore({}, recordingDiagnostics());
  store.attach({});
  const processor = createStoreProcessor(store);
  const root = serverRoot(1, {
    startMs: NOW - 2000,
    attributes: { "http.request.method": "GET", "http.route": "/a" },
  });
  processor.onEnd(root);
  processor.onEnd(
    fakeSpan({
      trace: 1,
      parent: { spanId: root.spanContext().spanId },
      kind: 2,
      startMs: NOW - 1900,
      durationMs: 5,
      attributes: {
        "db.system.name": "postgresql",
        "server.address": "db",
        "db.namespace": "shop",
      },
    }),
  );
  processor.onEnd(
    fakeSpan({
      trace: 2,
      startMs: NOW - 1000,
      attributes: { "http.route": "/boom" },
      status: { code: 2, message: "boom" },
    }),
  );
  store.drainNow();
  const stats = new RouteStatistics(NOW - 60_000);
  stats.record("GET", "/a", 12, false, NOW);
  const classes = new ClassStatistics(NOW - 60_000);
  classes.recordAt("AService", "service", "run", 4, false, NOW);
  return {
    store,
    stats,
    classes,
    service: { name: "shop" },
    sampling: { owner: "nestrix", rate: 1 },
    hostOwnsProvider: false,
    ignoresRoutes: false,
    fallbackProcessId: "x",
  };
}

const body = (r: { body?: unknown }) => JSON.parse(r.body as string);

describe("service filter", () => {
  it("is part of the specs", () => {
    for (const spec of [
      traceListSpec,
      errorListSpec,
      routeStatsSpec,
      classStatsSpec,
      appMapSpec,
    ]) {
      expect(spec.service).toEqual({ kind: "string", maxLength: 256 });
    }
    expect(parseQuery(`/x?service=${"a".repeat(257)}`, traceListSpec).ok).toBe(
      false,
    );
  });

  it("changes nothing when it names this application (or is empty)", () => {
    const s = sources();
    for (const query of ["", "?service=shop", "?service="]) {
      expect(body(tracesHandler(`/t${query}`, s)).items).toHaveLength(2);
      expect(body(errorsHandler(`/e${query}`, s)).items).toHaveLength(1);
      expect(body(routesHandler(`/r${query}`, s, NOW)).routes).toHaveLength(1);
      expect(body(classesHandler(`/c${query}`, s, NOW)).classes).toHaveLength(
        1,
      );
      expect(body(mapHandler(`/m${query}`, s, NOW)).nodes.length).toBe(2);
    }
  });

  it("answers empty results for another service, with the response's own fields intact", () => {
    const s = sources();
    const traces = body(tracesHandler("/t?service=other", s));
    expect(traces).toEqual({
      items: [],
      head: null,
      older: null,
      reset: false,
    });
    expect(body(errorsHandler("/e?service=other", s)).items).toEqual([]);
    const routes = body(
      routesHandler("/r?service=other&windowMinutes=60", s, NOW),
    );
    expect(routes).toMatchObject({
      windowMinutes: 60,
      bucketMs: 60_000,
      routes: [],
    });
    const classes = body(classesHandler("/c?service=other", s, NOW));
    expect(classes).toMatchObject({ windowMinutes: 15, classes: [] });
    expect(body(mapHandler("/m?service=other", s, NOW))).toMatchObject({
      windowMinutes: 15,
      nodes: [],
      edges: [],
    });
  });

  it("reports mode embedded in meta, and still rejects bad parameters", () => {
    const s = sources();
    expect(body(metaHandler("/meta", s, NOW)).mode).toBe("embedded");
    expect(body(metaHandler("/meta", s, NOW)).services).toBeUndefined();
    expect(tracesHandler("/t?service=a&service=b", s).status).toBe(400);
    expect(
      routesHandler("/r?windowMinutes=30&service=shop", s, NOW).status,
    ).toBe(400);
  });
});
