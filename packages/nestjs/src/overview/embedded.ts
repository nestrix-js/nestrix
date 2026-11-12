/**
 * `GET api/v1/overview` on the embedded dashboard: gathers the inputs of `computeOverview` from
 * the route statistics (counted before sampling) and the trace store (sampled), the same sources
 * as the routes, compare, dependencies and error-group endpoints. Never throws.
 */
import type { OverviewResponse, OverviewStatusMix } from "@nestrix-js/protocol";
import { windowCoverage } from "../stats/route-insights.js";
import { BUCKET_MS, type RouteStatistics } from "../stats/route-stats.js";
import { buildDependencies } from "../store/dependencies.js";
import type { SpanRecord } from "../store/protocol-types.js";
import { isErrorSpan, statusCodeOf, type TraceStore } from "../store/store.js";
import { computeOverview, type KindRow, type SpanFacts } from "./compute.js";

const str = (a: SpanRecord["attributes"], key: string): string | undefined => {
  const v = a[key];
  return typeof v === "string" && v !== "" ? v : undefined;
};

/** The facts `timeKeyOf` decides on, from a stored span. */
export function factsOf(span: SpanRecord): SpanFacts {
  const a = span.attributes;
  return {
    kind: span.kind,
    dbSystem: (str(a, "db.system.name") ?? str(a, "db.system"))?.toLowerCase(),
    messaging: str(a, "messaging.system") !== undefined,
    http:
      str(a, "http.request.method") !== undefined ||
      str(a, "http.method") !== undefined ||
      str(a, "url.full") !== undefined,
    nest:
      str(a, "nestrix.class") !== undefined ||
      str(a, "nestrix.component") !== undefined,
  };
}

const factsKey = (f: SpanFacts): string =>
  [f.kind, f.dbSystem ?? "", f.messaging, f.http, f.nest].join("\u0000");

class KindSums {
  private readonly rows = new Map<string, KindRow>();
  spans = 0;
  add(span: SpanRecord, ownMs: number): void {
    this.spans++;
    const facts = factsOf(span);
    const key = factsKey(facts);
    const row = this.rows.get(key);
    if (row === undefined) this.rows.set(key, { facts, ms: ownMs });
    else row.ms += ownMs;
  }
  values(): KindRow[] {
    return [...this.rows.values()];
  }
}

export interface OverviewSources {
  readonly stats: RouteStatistics;
  readonly store: TraceStore | undefined;
}

/** `none`: a `service` filter names another service, so the answer is empty. */
export function buildEmbeddedOverview(
  sources: OverviewSources,
  windowMinutes: number,
  apdexMs: number,
  now: number,
  none: boolean,
): OverviewResponse {
  const last = Math.floor(now / BUCKET_MS);
  const curFirst = last - windowMinutes + 1;
  const prevFirst = curFirst - windowMinutes;
  const curFromMs = curFirst * BUCKET_MS;
  const prevFromMs = prevFirst * BUCKET_MS;
  const store = none ? undefined : sources.store;
  const { previousCovered, note } = windowCoverage(
    sources.stats,
    windowMinutes,
    now,
  );

  const status: OverviewStatusMix = {
    ok: 0,
    redirect: 0,
    clientError: 0,
    serverError: 0,
  };
  const current = new KindSums();
  const previous = new KindSums();
  const firstSeen = new Map<string, number>();
  try {
    store?.scanMatching({ fromUnixMs: curFromMs, toUnixMs: now }, (root) => {
      const code = statusCodeOf(root);
      if (isErrorSpan(root) || (code !== undefined && code >= 500)) {
        status.serverError++;
      } else if (code !== undefined && code >= 400) status.clientError++;
      else if (code !== undefined && code >= 300) status.redirect++;
      else status.ok++;
    });
    store?.scanTraces(0, (root, spans, resource) => {
      const release = resource["service.version"];
      if (typeof release === "string" && release !== "") {
        const seen = firstSeen.get(release);
        if (seen === undefined || root.startTimeUnixMs < seen) {
          firstSeen.set(release, root.startTimeUnixMs);
        }
      }
      if (root.startTimeUnixMs < prevFromMs) return;
      const childMs = new Map<string, number>();
      for (const s of spans) {
        if (s.parentSpanId === undefined) continue;
        childMs.set(
          s.parentSpanId,
          (childMs.get(s.parentSpanId) ?? 0) + s.durationMs,
        );
      }
      for (const s of spans) {
        const at = s.startTimeUnixMs;
        const own = Math.max(0, s.durationMs - (childMs.get(s.spanId) ?? 0));
        if (at >= curFromMs && at <= now) current.add(s, own);
        else if (at >= prevFromMs && at < curFromMs) previous.add(s, own);
      }
    });
  } catch {
    // Answer with what was gathered.
  }

  const groups = (at: number) =>
    store?.groupErrors(windowMinutes, at).groups ?? [];
  return computeOverview({
    nowUnixMs: now,
    windowMinutes,
    apdexMs,
    previousCovered,
    note,
    rows: none
      ? []
      : sources.stats.minuteRows(previousCovered ? prevFirst : curFirst, last),
    status,
    kinds: current.values(),
    previousKinds: previous.spans === 0 ? null : previous.values(),
    releases: [...firstSeen.entries()]
      .filter(([, at]) => at >= curFromMs)
      .map(([version, firstSeenUnixMs]) => ({ version, firstSeenUnixMs }))
      .sort((a, b) => a.firstSeenUnixMs - b.firstSeenUnixMs),
    errorGroups: { current: groups(now), previous: groups(curFromMs - 1) },
    dependencies: {
      current: buildDependencies(store, windowMinutes, now).dependencies,
      previous: buildDependencies(store, windowMinutes, curFromMs - 1)
        .dependencies,
    },
  });
}
