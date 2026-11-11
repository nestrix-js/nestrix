import {
  parseEnvelope,
  type Recorded,
  type SpanRec,
  scenario,
  startRecorder,
  startScenario,
} from "./helpers.ts";

/** Every value under a key named trace_id / traceId anywhere in a payload. */
function traceIdsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) traceIdsIn(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "trace_id" || k === "traceId") && typeof v === "string") {
        out.add(v);
      } else traceIdsIn(v, out);
    }
  }
  return out;
}

export interface SentryRun {
  mode: string;
  result: any;
  stderr: string;
  /** Sentry envelope items received by the fake DSN, flattened. */
  items: {
    type: string;
    traceIds: string[];
    payload: any;
    requestHeaders: Recorded["headers"];
  }[];
  /** Outbound calls from GET /out to the downstream recorder. */
  outbound: { client: "fetch" | "http"; headers: Recorded["headers"] }[];
  nestrixSpans: SpanRec[];
  incomingTraceparent?: string;
  /** GET /s3/probe body: what Sentry and the OTel api see inside a request. */
  probe: any;
}

export async function runSentry(
  mode: string,
  opts: {
    traceparent?: string;
    boom?: boolean;
    fault?: string;
    legacyRoute?: boolean;
  } = {},
): Promise<SentryRun> {
  const sentry = await startRecorder();
  const downstream = await startRecorder();
  try {
    const run = await startScenario(
      scenario("sentry-app.mjs"),
      {
        S3_SENTRY_MODE: mode,
        S3_FAULT: opts.fault,
        S3_ROUTE_LEGACY: opts.legacyRoute ? "1" : undefined,
        SENTRY_DSN: `http://pk@127.0.0.1:${sentry.port}/1`,
        OUT_URL: `${downstream.url}/downstream`,
      },
      ["--import", scenario("sentry-instrument.mjs")],
    );
    const headers: Record<string, string> = opts.traceparent
      ? { traceparent: opts.traceparent }
      : {};
    const out = await run.get("/out", headers);
    if (out.status !== 200) throw new Error(`/out ${out.status} ${out.body}`);
    if (opts.boom) await run.get("/boom", headers);
    const probe = JSON.parse((await run.get("/s3/probe", headers)).body);
    const { result, stderr } = await run.finish();
    const items = sentry.requests.flatMap((r) =>
      parseEnvelope(r.body, r.headers["content-encoding"] as string).map(
        (i) => ({
          type: i.header.type as string,
          traceIds: [...traceIdsIn(i.payload)],
          payload: i.payload,
          requestHeaders: r.headers,
        }),
      ),
    );
    const outbound = downstream.requests.map((r) => ({
      // undici's fetch sends `user-agent: node`; http.get sends none.
      client: (r.headers["user-agent"] ? "fetch" : "http") as "fetch" | "http",
      headers: r.headers,
    }));
    const nestrixSpans: SpanRec[] = result.hostSpans ?? result.nestrixOwnStore;
    return {
      mode,
      result,
      stderr,
      items,
      outbound,
      nestrixSpans,
      incomingTraceparent: opts.traceparent,
      probe,
    };
  } finally {
    await sentry.close();
    await downstream.close();
  }
}

export function summarize(r: SentryRun) {
  const otelTraces = [...new Set(r.nestrixSpans.map((s) => s.traceId))];
  const sentryByType: Record<string, string[]> = {};
  for (const i of r.items) {
    sentryByType[i.type] = [
      ...new Set([...(sentryByType[i.type] ?? []), ...i.traceIds]),
    ];
  }
  return {
    mode: r.mode,
    nestrix: r.result.nestrix,
    otelSpans: r.nestrixSpans.map(
      (s) =>
        `${s.name}[${s.scope}] t=${s.traceId.slice(0, 8)} p=${s.parentSpanId?.slice(0, 8) ?? "-"}`,
    ),
    otelTraces,
    sentryItemTypes: r.items.map((i) => i.type),
    sentryTraceIdsByType: sentryByType,
    outbound: r.outbound.map((o) => ({
      client: o.client,
      traceparent: o.headers.traceparent,
      "sentry-trace": o.headers["sentry-trace"],
      baggage: o.headers.baggage,
    })),
    sentryTransportHeaders: [
      ...new Set(r.items.map((i) => i.requestHeaders.traceparent ?? "none")),
    ],
    faults: r.result.faults,
  };
}
