// F3 (review): concurrent pool.query calls sharing one config object (the named
// prepared-statement pattern), on a one-connection pool so they queue.
//   PG_URL=... node scripts/pg-shared.mjs
import { trace } from "@opentelemetry/api";
import pg from "pg";
import {
  enablePg,
  finishedSpans,
  setupTracing,
} from "../dist/src/nestrix/index.js";

setupTracing();
const report = enablePg();
const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 1 });
const direct = new pg.Client({ connectionString: process.env.PG_URL });
await direct.connect();
const stmt = { name: "s2-shared", text: "SELECT pg_sleep(0.1), 1 AS n" };
const tracer = trace.getTracer("pg-shared");
const run = (label, fn) =>
  tracer.startActiveSpan(label, async (span) => {
    try {
      await fn();
      return span.spanContext().spanId;
    } finally {
      span.end();
    }
  });

// 1. Three handlers, one shared config, queued on the pool.
const [a, b, c] = await Promise.all([
  run("A", () => pool.query(stmt)),
  run("B", () => pool.query(stmt)),
  run("C", () => pool.query(stmt)),
]);

// 2. Residual ambiguity: a direct client.query(sameConfig) issued while a pool.query
//    with that config is still queued behind another one.
const pool2 = new pg.Pool({ connectionString: process.env.PG_URL, max: 1 });
const stmt2 = { name: "s2-shared-2", text: "SELECT pg_sleep(0.1), 2 AS n" };
const [d, e, f] = await Promise.all([
  run("D pool", () => pool2.query({ text: "SELECT pg_sleep(0.1)" })),
  run("E pool (queued)", () => pool2.query(stmt2)),
  run("F direct", () =>
    new Promise((r) => setTimeout(r, 20)).then(() => direct.query(stmt2)),
  ),
]);
await pool.end();
await pool2.end();
await direct.end();

const spans = finishedSpans();
const under = (id) =>
  spans
    .filter((s) => s.parentSpanId === id)
    .map((s) => s.attributes["nestrix.pg.via"]);
process.stdout.write(
  `__PG_SHARED__${JSON.stringify({
    report: report.enabled,
    shared: { A: under(a), B: under(b), C: under(c) },
    residual: { D: under(d), E: under(e), F: under(f) },
    pgSpans: spans.filter((s) => s.name.startsWith("pg ")).length,
  })}\n`,
);
