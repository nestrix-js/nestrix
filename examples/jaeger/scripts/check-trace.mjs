// End-to-end check: Jaeger (docker compose) + service-a + service-b, one request, one trace.
//
//   pnpm build && node examples/jaeger/scripts/check-trace.mjs [--no-compose]
//
// --no-compose   assume Jaeger is already up (CI services, or `docker compose up -d` by hand);
//                nothing is started or stopped for it.
// Env: JAEGER_QUERY_URL (default http://127.0.0.1:16686), OTLP_URL (default http://127.0.0.1:4318),
//      CHECK_TIMEOUT_MS (default 60000).
//
// Queries Jaeger v2's api_v3 HTTP endpoint (GET /api/v3/traces); the v1 /api/traces endpoint is gone.
// Exits 0 when one trace holds all three spans with the right parenting, 1 otherwise.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const noCompose = process.argv.includes("--no-compose");
const queryUrl = process.env.JAEGER_QUERY_URL ?? "http://127.0.0.1:16686";
const otlpUrl = process.env.OTLP_URL ?? "http://127.0.0.1:4318";
const timeoutMs = Number(process.env.CHECK_TIMEOUT_MS ?? 60_000);

const SPAN_KIND = {
  server: [2, "SPAN_KIND_SERVER"],
  client: [3, "SPAN_KIND_CLIENT"],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let composeStarted = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function cleanup() {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  if (composeStarted) {
    spawnSync("docker", ["compose", "down", "--volumes", "--timeout", "5"], {
      cwd: root,
      stdio: "inherit",
    });
    composeStarted = false;
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

async function waitFor(what, probe, ms) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(
    `${what} not ready within ${ms} ms${last ? ` (${last.message})` : ""}`,
  );
}

function startApp(name, port, extraEnv = {}) {
  const child = spawn(process.execPath, [`dist/${name}.js`], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      OTEL_EXPORTER_OTLP_ENDPOINT: otlpUrl,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const keep = (d) => {
    out = (out + d).slice(-4000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.logs = () => out;
  children.push(child);
  return child;
}

/** Jaeger returns one JSON document, or newline-delimited chunks; accept both. */
function parseBody(text) {
  try {
    return [JSON.parse(text)];
  } catch {
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }
}

async function fetchSpans(service, sinceMs) {
  const params = new URLSearchParams({
    "query.service_name": service,
    "query.start_time_min": new Date(sinceMs).toISOString(),
    "query.start_time_max": new Date(Date.now() + 60_000).toISOString(),
    "query.search_depth": "50",
  });
  const res = await fetch(`${queryUrl}/api/v3/traces?${params}`);
  const text = await res.text();
  if (res.status === 404 && text.includes("No traces found")) return [];
  if (!res.ok)
    throw new Error(
      `GET /api/v3/traces -> ${res.status} ${text.slice(0, 200)}`,
    );
  const spans = [];
  for (const doc of parseBody(text)) {
    for (const rs of doc.result?.resourceSpans ?? []) {
      const attr = rs.resource?.attributes?.find(
        (a) => a.key === "service.name",
      );
      const service = attr?.value?.stringValue ?? "?";
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) spans.push({ ...s, service });
      }
    }
  }
  return spans;
}

const isKind = (s, k) => SPAN_KIND[k].includes(s.kind);
const parentOf = (s) => s.parentSpanId || "";

/** Evaluates one trace; returns the list of problems (empty when it passes). */
function evaluate(spans) {
  const problems = [];
  const describe = (s) => `${s.service}/${s.name}[kind ${s.kind}]`;
  const aServer = spans.find(
    (s) =>
      s.service === "service-a" &&
      isKind(s, "server") &&
      s.name === "GET /call/:id",
  );
  if (!aServer)
    problems.push("missing service-a server span named 'GET /call/:id'");
  const aClients = spans.filter(
    (s) => s.service === "service-a" && isKind(s, "client"),
  );
  if (aClients.length === 0)
    problems.push("missing service-a client span (outbound fetch)");
  const bServer = spans.find(
    (s) =>
      s.service === "service-b" &&
      isKind(s, "server") &&
      s.name === "GET /items/:id",
  );
  if (!bServer)
    problems.push("missing service-b server span named 'GET /items/:id'");
  if (
    aServer &&
    aClients.length > 0 &&
    !aClients.some((c) => parentOf(c) === aServer.spanId)
  ) {
    problems.push(
      `no service-a client span is a child of the service-a server span (${aServer.spanId})`,
    );
  }
  if (
    bServer &&
    aClients.length > 0 &&
    !aClients.some((c) => c.spanId === parentOf(bServer))
  ) {
    problems.push(
      `service-b server span's parent (${parentOf(bServer) || "none"}) is not a service-a client span (have: ${aClients.map((c) => c.spanId).join(", ")})`,
    );
  }
  return { problems, summary: spans.map(describe) };
}

async function main() {
  if (!noCompose) {
    const up = spawnSync("docker", ["compose", "up", "-d"], {
      cwd: root,
      stdio: "inherit",
    });
    if (up.status !== 0) throw new Error("docker compose up failed");
    composeStarted = true;
  }
  await waitFor(
    "Jaeger query API",
    async () => (await fetch(`${queryUrl}/api/v3/services`)).ok,
    60_000,
  );

  const [portA, portB] = [await freePort(), await freePort()];
  const b = startApp("service-b", portB);
  const a = startApp("service-a", portA, {
    SERVICE_B_URL: `http://127.0.0.1:${portB}`,
  });
  const up = (port, child) => async () => {
    if (child.exitCode !== null)
      throw new Error(`exited with ${child.exitCode}:\n${child.logs()}`);
    return (await fetch(`http://127.0.0.1:${port}/`)).status > 0;
  };
  await waitFor("service-b", up(portB, b), 30_000);
  await waitFor("service-a", up(portA, a), 30_000);

  const since = Date.now() - 5_000;
  const res = await fetch(`http://127.0.0.1:${portA}/call/42`);
  const body = await res.text();
  console.log(`GET service-a /call/42 -> ${res.status} ${body}`);
  if (!res.ok) throw new Error("service-a request failed");

  // Spans are exported on a timer (default 5 s), so poll.
  const deadline = Date.now() + timeoutMs;
  let best = null;
  let services = [];
  while (Date.now() < deadline) {
    services =
      (await (await fetch(`${queryUrl}/api/v3/services`)).json()).services ??
      [];
    const spans = await fetchSpans("service-a", since);
    const traces = new Map();
    for (const s of spans)
      traces.set(s.traceId, [...(traces.get(s.traceId) ?? []), s]);
    for (const [traceId, ts] of traces) {
      const r = evaluate(ts);
      if (!best || r.problems.length < best.problems.length)
        best = { traceId, ...r };
    }
    if (best && best.problems.length === 0) {
      console.log(
        `PASS: trace ${best.traceId}\n  ${best.summary.join("\n  ")}`,
      );
      return 0;
    }
    await sleep(1_000);
  }

  console.error(`FAIL: no complete trace within ${timeoutMs} ms.`);
  console.error(`Services known to Jaeger: ${services.join(", ") || "(none)"}`);
  if (!services.includes("service-a"))
    console.error("  service-a has exported nothing");
  if (!services.includes("service-b"))
    console.error("  service-b has exported nothing");
  if (best) {
    console.error(
      `Best trace ${best.traceId} holds:\n  ${best.summary.join("\n  ")}`,
    );
    console.error("Missing or wrong:");
    for (const p of best.problems) console.error(`  - ${p}`);
  } else {
    console.error("No trace for service-a was found at all.");
    console.error(
      "Missing or wrong:\n  - missing service-a server span\n  - missing service-a client span\n  - missing service-b server span",
    );
  }
  console.error(
    `--- service-a output ---\n${a.logs()}\n--- service-b output ---\n${b.logs()}`,
  );
  return 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`ERROR: ${e.message}`);
} finally {
  cleanup();
}
process.exit(code);
