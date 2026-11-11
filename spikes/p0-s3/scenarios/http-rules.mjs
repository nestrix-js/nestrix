// Review fix 6: the outbound rules. Nestrix owns the provider here. A local recorder
// server (in this process; servers are not traced by the client subscriber) records
// the headers each request arrives with. Cases, for node:http and fetch:
//   with-parent   inside an active span: client span + traceparent (control)
//   no-parent     no active span: no client span, no header
//   suppressed    inside an active span, under @opentelemetry/core suppressTracing()
//   export        a BatchSpanProcessor's exporter POSTs with node:http while a span is
//                 active (forceFlush called inside it): the SDK's own suppressTracing
//                 around export is what must stop the subscriber
import http from "node:http";
import { context, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import {
  httpSkips,
  nestrixSpanProcessor,
  setupNestrix,
} from "../src/nestrix/setup.mjs";

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ path: req.url, traceparent: req.headers.traceparent ?? null });
  req.resume();
  req.on("end", () => res.end("ok"));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const httpGet = (path) =>
  new Promise((resolve, reject) => {
    http
      .get(base + path, (res) => {
        res.resume();
        res.on("end", resolve);
      })
      .on("error", reject);
  });
const fetchGet = async (path) => {
  const res = await fetch(base + path);
  await res.arrayBuffer();
};

// An exporter that sends each batch with node:http, as an OTLP/HTTP exporter would.
const exporter = {
  export(spans, done) {
    const req = http.request(`${base}/export`, { method: "POST" }, (res) => {
      res.resume();
      res.on("end", () => done({ code: 0 }));
    });
    req.on("error", () => done({ code: 1 }));
    req.end(JSON.stringify(spans.map((s) => s.name)));
  },
  shutdown: () => Promise.resolve(),
};
const store = nestrixSpanProcessor();
const batch = new BatchSpanProcessor({ exporter });
// One duck-typed processor forwarding to both (setupNestrix takes one).
const both = {
  onStart: (s, c) => {
    store.onStart(s, c);
    batch.onStart(s, c);
  },
  onEnd: (s) => {
    store.onEnd(s);
    batch.onEnd(s);
  },
  forceFlush: () => Promise.all([store.forceFlush(), batch.forceFlush()]),
  shutdown: () => Promise.all([store.shutdown(), batch.shutdown()]),
};
const nx = setupNestrix({ processor: both });
const tracer = trace.getTracer("rules");

await tracer.startActiveSpan("parent", async (span) => {
  await httpGet("/with-parent/http");
  await fetchGet("/with-parent/fetch");
  await context.with(suppressTracing(context.active()), async () => {
    await httpGet("/suppressed/http");
    await fetchGet("/suppressed/fetch");
  });
  span.end();
});
await httpGet("/no-parent/http");
await fetchGet("/no-parent/fetch");

const before = store.store.spans.length;
await tracer.startActiveSpan("flush-inside-span", async (span) => {
  await nx.provider.forceFlush(); // the export request runs under an active span
  span.end();
});
const clientSpansDuringExport = store.store.spans
  .slice(before)
  .filter((s) => s.kind === 2);

process.stdout.write(
  `RESULT ${JSON.stringify({
    node: process.version,
    providerRegistered: nx.providerRegistered,
    seen,
    clientSpans: store.store.spans
      .filter((s) => s.kind === 2)
      .map(
        (s) => s.attributes["url.path"] ?? s.attributes["url.full"] ?? s.name,
      ),
    clientSpansDuringExport: clientSpansDuringExport.length,
    httpSkips,
  })}\n`,
);
server.close();
process.exit(0);
