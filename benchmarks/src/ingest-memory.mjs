// Standalone server ingest memory: what the receiver really holds while N concurrent OTLP
// exports near the size cap arrive in many small chunks, against what the in-flight budget
// (`inflightBudgetBytes`) charges. Run `pnpm build` first (it loads apps/server/dist).
//
//   node src/ingest-memory.mjs [--sink=postgres|memory] [--budget-mib=64] [--max-body-mib=16]
//        [--concurrency=8] [--duration=8] [--write-bytes=4096] [--profiles=a,b]
//        [--sink-delay-ms=0] [--exec-argv="--max-old-space-size=256"] [--name=ingest-memory]
//        [--external-port=4318]   (load only, against ingest-memory-server.mjs started elsewhere,
//                                  e.g. in a container with a memory limit; see results/ingest-memory.md)
//
// Profiles: pb-strings, pb-strings-gzip, json-strings, json-strings-gzip (spans with one 16 KiB
// attribute each, so the body bytes dominate the charge), pb-small, pb-small-gzip (as many small
// spans as the message cap allows, so the per-message decode estimate dominates).
// Bodies are about 95% of --max-body-mib (inflated size for gzip). Each of --concurrency
// connections sends one profile back to back for --duration seconds; every request is written
// in --write-bytes pieces with a macrotask between them (a slow client), so the server sees
// thousands of chunks per body and the requests overlap.
// With --sink=postgres and no DATABASE_URL a throwaway postgres:18-alpine container is started
// (and stopped). Results: results/<name>.json and .md.
import { execFile, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  environmentInfo,
  mdTable,
  numberOption,
  option,
  parseArgs,
  round,
  sleep,
  writeResult,
} from "./lib.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..", "..", "apps", "server");
const MIB = 1024 * 1024;
const mib = (b) => round(b / MIB, 1);

const requireFromServer = createRequire(join(serverDir, "package.json"));
const pb = await import(
  pathToFileURL(requireFromServer.resolve("@bufbuild/protobuf")).href
);
const { ExportTraceServiceRequestSchema } = await import(
  pathToFileURL(
    join(
      serverDir,
      "dist/proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js",
    ),
  ).href
);

const hex = (bytes) => randomBytes(bytes).toString("hex");

/** An OTLP JSON span (hex ids, as OTLP/JSON sends them). */
function span(i, attrs) {
  const start = 1_800_000_000_000_000_000n + BigInt(i) * 1000n;
  return {
    traceId: hex(16),
    spanId: hex(8),
    name: `op ${i % 50}`,
    kind: 2,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 5_000_000n),
    attributes: attrs,
  };
}

function request(spans) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "mem-bench" } },
          ],
        },
        scopeSpans: [{ scope: { name: "bench" }, spans }],
      },
    ],
  };
}

/** JSON OTLP -> protobuf bytes (hex ids become bytes). */
function toProtobuf(json) {
  const b64 = (h) => Buffer.from(h, "hex").toString("base64");
  const copy = structuredClone(json);
  for (const rs of copy.resourceSpans)
    for (const ss of rs.scopeSpans)
      for (const s of ss.spans) {
        s.traceId = b64(s.traceId);
        s.spanId = b64(s.spanId);
      }
  const msg = pb.fromJson(ExportTraceServiceRequestSchema, copy);
  return Buffer.from(pb.toBinary(ExportTraceServiceRequestSchema, msg));
}

/** Grows a request span by span until its encoded size reaches `target`. */
function build(kind, format, target) {
  const spans = [];
  const make =
    kind === "strings"
      ? (i) =>
          span(i, [
            // 8 KiB of random hex: 16 KiB of text that gzips to about half.
            { key: "db.statement", value: { stringValue: hex(8 * 1024) } },
            { key: "http.route", value: { stringValue: "/users/:id" } },
          ])
      : (i) =>
          span(i, [
            { key: "http.route", value: { stringValue: `/r/${i % 40}` } },
            { key: "http.status_code", value: { intValue: "200" } },
            { key: "net.peer", value: { stringValue: `10.0.${i % 255}.1` } },
          ]);
  // Estimate the per-span size from a sample, then build.
  const per = (n) => {
    const s = Array.from({ length: n }, (_, i) => make(i));
    const enc =
      format === "json"
        ? Buffer.from(JSON.stringify(request(s)))
        : toProtobuf(request(s));
    return enc.length / n;
  };
  let count = Math.floor(target / per(64));
  if (kind === "small") count = Math.min(count, 55_000); // 7 messages per span: under 400 000
  for (let i = 0; i < count; i++) spans.push(make(i));
  const json = request(spans);
  return format === "json"
    ? Buffer.from(JSON.stringify(json))
    : toProtobuf(json);
}

function profile(name, maxBody) {
  const target = Math.floor(maxBody * 0.95);
  const [fmt, kind, gz] = name.split("-");
  const format = fmt === "pb" ? "protobuf" : "json";
  const raw = build(kind, format, target);
  return {
    name,
    contentType:
      format === "json" ? "application/json" : "application/x-protobuf",
    gzip: gz === "gzip",
    inflated: raw.length,
    body: gz === "gzip" ? gzipSync(raw) : raw,
  };
}

/** One request over a raw socket, the body in `writeBytes` pieces with a macrotask between. */
function send(port, p, writeBytes) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.setNoDelay(true);
    let response = "";
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(status);
    };
    socket.on("data", (d) => {
      response += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(response);
      if (m && response.includes("\r\n\r\n")) finish(Number(m[1]));
    });
    socket.on("error", () => finish("reset"));
    socket.on("close", () => finish("closed"));
    socket.on("connect", async () => {
      socket.write(
        `POST /v1/traces HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${p.contentType}\r\n${
          p.gzip ? "Content-Encoding: gzip\r\n" : ""
        }Content-Length: ${p.body.length}\r\nConnection: close\r\n\r\n`,
      );
      for (let off = 0; off < p.body.length && !done; off += writeBytes) {
        const ok = socket.write(p.body.subarray(off, off + writeBytes));
        if (!ok) await new Promise((r) => socket.once("drain", r));
        await new Promise((r) => setImmediate(r));
      }
    });
  });
}

async function startPostgres() {
  const { stdout } = await run("docker", [
    "run",
    "--rm",
    "-d",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql",
    "postgres:18-alpine",
    "-c",
    "fsync=off",
  ]);
  const id = stdout.trim();
  const { stdout: portOut } = await run("docker", ["port", id, "5432/tcp"]);
  const port = portOut.trim().split("\n")[0].split(":").pop();
  for (let i = 0; i < 60; i++) {
    try {
      await run("docker", ["exec", id, "pg_isready", "-U", "postgres"]);
      break;
    } catch {
      await sleep(500);
    }
  }
  await sleep(1000);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: () => run("docker", ["stop", "--time", "2", id]).catch(() => {}),
  };
}

function startServer(cfg, execArgv) {
  return new Promise((resolve, reject) => {
    const child = fork(join(here, "ingest-memory-server.mjs"), [], {
      execArgv: ["--expose-gc", ...execArgv],
      env: { ...process.env, NESTRIX_MEM_CONFIG: JSON.stringify(cfg) },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const call = (type) =>
      new Promise((res, rej) => {
        const onMsg = (m) => {
          if (m.type === type) {
            child.off("message", onMsg);
            res(m);
          } else if (m.type === "error") rej(new Error(m.message));
        };
        child.on("message", onMsg);
        child.send({ type });
      });
    let exit;
    child.on("exit", (code, signal) => {
      exit = { code, signal };
    });
    child.once("message", (m) => {
      if (m.type === "ready")
        resolve({ port: m.port, call, child, exited: () => exit });
      else reject(new Error(JSON.stringify(m)));
    });
    child.once("exit", (code, signal) =>
      reject(new Error(`server exited early: ${code ?? signal}`)),
    );
  });
}

/** Load only, against a server started elsewhere (`--external-port`, e.g. in a container). */
async function runExternal(p, port, opts) {
  const statuses = {};
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: opts.concurrency }, async () => {
      while (Date.now() - t0 < opts.duration * 1000) {
        const s = await send(port, p, opts.writeBytes);
        statuses[s] = (statuses[s] ?? 0) + 1;
        if (s !== 200) await sleep(50);
      }
    }),
  );
  return { profile: p.name, external: true, statuses };
}

async function runProfile(p, cfg, opts) {
  if (opts.externalPort) return runExternal(p, opts.externalPort, opts);
  const server = await startServer(cfg, opts.execArgv);
  // Warm up: one request, so lazy code paths are compiled before the baseline.
  await send(server.port, p, 64 * 1024);
  const { base } = await server.call("baseline");
  const statuses = {};
  const t0 = Date.now();
  let crashed;
  await Promise.all(
    Array.from({ length: opts.concurrency }, async () => {
      while (Date.now() - t0 < opts.duration * 1000) {
        const s = await send(server.port, p, opts.writeBytes);
        statuses[s] = (statuses[s] ?? 0) + 1;
        if (server.exited()) {
          crashed = server.exited();
          return;
        }
        if (s !== 200) await sleep(50);
      }
    }),
  );
  if (crashed || server.exited()) {
    return { profile: p.name, crashed: crashed ?? server.exited(), statuses };
  }
  await sleep(200);
  const report = await server.call("report");
  await new Promise((r) => {
    server.child.once("exit", r);
    server.child.send({ type: "close" });
  });
  const pk = report.peak;
  const cap = report.capacity;
  return {
    profile: p.name,
    bodyBytes: p.body.length,
    inflatedBytes: p.inflated,
    statuses,
    capacity: cap,
    peakCharged: pk.charged,
    inUseAfter: report.inUseAfter,
    base,
    peak: pk,
    deltas: {
      arrayBuffers: pk.arrayBuffers - base.arrayBuffers,
      external: pk.external - base.external,
      heapUsed: pk.heapUsed - base.heapUsed,
      extPlusHeap: pk.extPlusHeap - (base.external + base.heapUsed),
      rss: Math.max(pk.rss, pk.workerRss) - base.rss,
      arrayBuffersAtConcat: pk.concat.maxArrayBuffers - base.arrayBuffers,
    },
  };
}

async function main() {
  const args = parseArgs();
  const sinkKind = String(option(args, "sink", "postgres"));
  const budget = numberOption(args, "budget-mib", 64) * MIB;
  const maxBody = numberOption(args, "max-body-mib", 16) * MIB;
  const name = String(option(args, "name", "ingest-memory"));
  const opts = {
    concurrency: numberOption(args, "concurrency", 8),
    duration: numberOption(args, "duration", 8),
    writeBytes: numberOption(args, "write-bytes", 4096),
    externalPort: numberOption(args, "external-port", 0),
    execArgv: String(option(args, "exec-argv", ""))
      .split(" ")
      .filter(Boolean),
  };
  const profiles = String(
    option(
      args,
      "profiles",
      "pb-strings,pb-strings-gzip,json-strings,json-strings-gzip,pb-small,pb-small-gzip",
    ),
  ).split(",");

  let pg;
  let databaseUrl = process.env.DATABASE_URL;
  if (
    sinkKind === "postgres" &&
    databaseUrl === undefined &&
    !opts.externalPort
  ) {
    pg = await startPostgres();
    databaseUrl = pg.url;
  }
  const cfg = {
    sink: sinkKind,
    databaseUrl,
    budgetBytes: budget,
    maxBodyBytes: maxBody,
    sinkDelayMs: numberOption(args, "sink-delay-ms", 0),
  };
  const results = [];
  try {
    for (const name of profiles) {
      const p = profile(name, maxBody);
      console.log(
        `${name}: ${mib(p.body.length)} MiB on the wire, ${mib(p.inflated)} MiB inflated`,
      );
      const r = await runProfile(p, cfg, opts);
      console.log(JSON.stringify({ ...r, base: undefined, peak: undefined }));
      results.push(r);
    }
  } finally {
    await pg?.stop();
  }

  const rows = results.map((r) =>
    r.external
      ? [
          r.profile,
          `${mib(r.bodyBytes ?? 0)}`,
          JSON.stringify(r.statuses),
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ]
      : r.crashed
        ? [
            r.profile,
            "crashed",
            JSON.stringify(r.crashed),
            "",
            "",
            "",
            "",
            "",
            "",
          ]
        : [
            r.profile,
            `${mib(r.bodyBytes)} / ${mib(r.inflatedBytes)}`,
            Object.entries(r.statuses)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", "),
            mib(r.peakCharged),
            mib(r.deltas.arrayBuffers),
            mib(r.deltas.arrayBuffersAtConcat),
            mib(r.deltas.heapUsed),
            mib(r.deltas.extPlusHeap),
            mib(r.deltas.rss),
            round(r.deltas.extPlusHeap / r.capacity, 2),
          ],
  );
  const md = [
    `# Standalone server ingest memory (${name})`,
    "",
    `Command: \`node src/ingest-memory.mjs ${process.argv.slice(2).join(" ")}\``,
    "",
    `Environment: ${JSON.stringify(environmentInfo())}. Sink: ${sinkKind}. Budget ${mib(budget)} MiB, body limit ${mib(maxBody)} MiB, ${opts.concurrency} connections for ${opts.duration} s each, ${opts.writeBytes}-byte client writes.`,
    "",
    "Deltas are peaks over a post-GC baseline taken after one warm-up request. MiB.",
    "",
    mdTable(
      [
        "profile",
        "wire / inflated",
        "answers",
        "peak charged",
        "peak arrayBuffers",
        "arrayBuffers at concat",
        "peak heapUsed",
        "peak external+heap",
        "peak RSS",
        "external+heap / budget",
      ],
      rows,
    ),
    "",
  ].join("\n");
  console.log(md);
  writeResult(name, { environment: environmentInfo(), cfg, opts, results }, md);
}

await main();
