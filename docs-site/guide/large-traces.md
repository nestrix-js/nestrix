# Large traces

One background job that touches every row of a table can put thousands, or millions, of spans into one trace: one per query, per Redis command, per method call. A trace like that cannot be shown usefully, and every span costs memory, export bandwidth and storage. Nestrix therefore caps a trace in two places, counts what it leaves out, and says so in the dashboard.

## In the app: `maxSpansPerTrace`

`maxSpansPerTrace` (default `10000`, at least `100`, `false` turns it off) is the most spans one trace records in this process. It is documented with the other options in the [reference](/reference/configuration#large-traces-maxspanspertrace).

```ts
NestrixModule.forRoot({
  // At most 5,000 spans per trace in this process; the rest are counted on the root span.
  maxSpansPerTrace: 5_000,
});
```

- Past the limit a span is not recorded, and neither are its children. The trace keeps its first `maxSpansPerTrace` spans, root included.
- What was left out is counted by kind (`db`, `http-out`, `redis`, `messaging`, `app` for your own classes, `other`) and written on the trace's local root span when it ends (the request's server span, or the job's span) as `nestrix.trace.spans_dropped` and `nestrix.trace.spans_dropped.<kind>`. A trace under the limit gets no such attribute.
- Route statistics, the Classes view and the request-duration metric are counted before sampling, so a limited trace still counts in full there.
- The limit is per process. A trace that crosses three services can have up to three times as many spans, because each service applies its own.
- A call made from a recorded span carries the usual `traceparent`. A call made from a span that was left out carries the trace id with the sampled flag off, so a service that follows its parent's decision records nothing for it either. That keeps "children of a left-out span are left out" across services.
- When your app owns the OpenTelemetry SDK, Nestrix limits only the spans it creates; your sampler decides the rest.

## In the standalone server: `NESTRIX_MAX_SPANS_PER_TRACE`

The [standalone server](/guide/standalone-server) stores at most `NESTRIX_MAX_SPANS_PER_TRACE` spans per trace (default `50000`, from 1,000 to 10,000,000). Spans past the cap are not stored. They are counted per trace, and the export is answered with OTLP partial success: the rejected count includes them and the message says why. Spans with no parent, and spans that carry the app's own drop counts, are never dropped, so a trace's root and its counts always arrive. The server's cap is a guard against runaway traces, not against a client you do not trust.

## What the dashboard shows

When a trace was capped, the trace view shows a banner above the waterfall: how many spans were counted but not recorded, whether the app's limit or the server's cap did it, and the per-kind counts of the app's share. The waterfall has an "(omitted N spans)" row under the root. The `trace` API answer carries the same numbers as `droppedSpans` (`total`, `byKind`, `byServer`). The trace list has no marker for capped traces.

## How other tools do it

Every mature tool caps a trace, with different numbers (the figures are from their public documentation, as recorded in decision D-78):

| Tool | What it does |
|---|---|
| Elastic APM | 500 spans per transaction, and counts the dropped ones |
| Sentry | 1,000 spans per transaction |
| Sumo Logic | 10,000 spans per trace |
| Grafana Tempo | 5 MB per trace by default; 60 MB is the recommended maximum |
| Honeycomb | Shows at most 32,000 spans, with "omitted N spans" |

Nestrix's default of 10,000 in the app and 50,000 in the server sits at the generous end of that range, because the dashboard is for finding why one request or job was slow, and the counts keep the picture honest. Lower `maxSpansPerTrace` if a job's trace is still too heavy to open.

## Choosing a value

Leave the defaults unless a trace is slow to open or your database grows too fast. A smaller `maxSpansPerTrace` (1,000 to 5,000) keeps long jobs light and is enough to find the slow statement; the counts by kind still tell you the job made, say, 90,000 database calls. For a job that is an N+1 by design, the [route detail](/guide/route-detail) page and the Queries page find it from statistics without needing every span.
