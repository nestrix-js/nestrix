// A separate process standing in for the OTLP backend, so its CPU is not in the app's numbers.
//   node sink.mjs sink       answers 200 `{}` to POST /v1/traces, counts requests, bytes and spans
//   node sink.mjs blackhole  accepts the request and never answers; counts requests that arrived
// Started by lib.mjs with an IPC channel: it reports `{ type: "listening", port }` and answers
// `{ type: "stats" }` with `{ type: "stats", posts, bytes, spans, open }`.
import { createServer } from "node:http";

const mode = process.argv[2] ?? "sink";
let posts = 0;
let bytes = 0;
let spans = 0;
let open = 0;

const server = createServer((req, res) => {
  open++;
  res.on("close", () => {
    open--;
  });
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    posts++;
    const body = Buffer.concat(chunks);
    bytes += body.length;
    if (mode === "blackhole") return; // never answer
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      for (const rs of parsed.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) spans += (ss.spans ?? []).length;
      }
    } catch {
      // not JSON (protobuf from another exporter): count the post and bytes only
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});

server.listen(0, "127.0.0.1", () => {
  process.send?.({ type: "listening", port: server.address().port });
});

process.on("message", (m) => {
  if (m?.type === "stats")
    process.send?.({ type: "stats", posts, bytes, spans, open });
});
process.on("disconnect", () => process.exit(0));
