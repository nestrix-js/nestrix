// Q7: does instrumentation change library behaviour? Run once per MODE in a fresh process:
//   MODE=off     nothing subscribed, nothing wrapped (the libraries' own behaviour)
//   MODE=on      enableAll(): pg wrapped, mysql2/ioredis/http channels subscribed
//   MODE=faults  enableAll() with a throw injected into every guarded body
//   MODE=bare    empty TracingChannel subscribers on mysql2/ioredis, no Nestrix code
// It prints the observations as JSON; the test asserts off == on == faults.
// Plain `node dist/src/q7/behaviour.js`, no flags. PG_URL / MYSQL_URL / REDIS_URL select
// which libraries run.
import dc from "node:diagnostics_channel";
import { Redis } from "ioredis";
import { Redis as Redis5 } from "ioredis5";
import mysql from "mysql2";
import mysqlPromise from "mysql2/promise";
import pg from "pg";
import Cursor from "pg-cursor";
import QueryStream from "pg-query-stream";
import { enableAll, failures, finishedSpans } from "../nestrix/index.js";

const mode = process.env.MODE ?? "off";
const ALL_FAULTS = [
  "pg.client.query",
  "pg.pool.query",
  "channel:mysql2:query",
  "channel:mysql2:execute",
  "channel:ioredis:command",
  "http.created",
  "http.finish",
];
if (mode === "on") enableAll();
if (mode === "faults") enableAll({ faults: ALL_FAULTS });
if (mode === "plain-start") {
  // Review F1: the lightest possible subscription, a plain channel subscriber on the
  // TracingChannel's `start` sub-channel only.
  for (const name of ["mysql2:query", "mysql2:execute", "ioredis:command"]) {
    dc.subscribe(`tracing:${name}:start`, () => {});
  }
}
if (mode === "pool-connect-only") {
  // Option (d) in the result file: only channels whose subscription changes nothing.
  const noop = () => {};
  dc.tracingChannel("mysql2:pool:connect").subscribe({
    start: noop,
    end: noop,
    asyncStart: noop,
    asyncEnd: noop,
    error: noop,
  });
}
if (mode === "tc-start-only") {
  for (const name of ["mysql2:query", "mysql2:execute", "ioredis:command"]) {
    dc.tracingChannel(name).start.subscribe(() => {});
  }
}
if (mode === "bare") {
  // No Nestrix code at all: empty subscribers, to show which differences come from the
  // libraries reacting to the mere presence of a subscriber.
  const noop = () => {};
  for (const name of ["mysql2:query", "mysql2:execute", "ioredis:command"]) {
    dc.tracingChannel(name).subscribe({
      start: noop,
      end: noop,
      asyncStart: noop,
      asyncEnd: noop,
      error: noop,
    });
  }
}

const unhandled: string[] = [];
const uncaught: string[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(describe(reason));
});
process.on("uncaughtException", (error) => {
  uncaught.push(describe(error));
});

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    return `${e.constructor.name}${code ? `(${code})` : ""}: ${e.message}`;
  }
  return `non-error: ${String(e)}`;
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
/** Waits for an expected process event (or gives up after `ms`), then one more tick. */
async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  for (let waited = 0; waited < ms && !cond(); waited += 10) await tick(10);
  await tick(20);
}
const obs: Record<string, unknown> = {};

async function settle<T>(p: Promise<T>): Promise<unknown> {
  try {
    return { ok: await p };
  } catch (e) {
    return { err: describe(e) };
  }
}

async function pgChecks(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const proto = pg.Client.prototype.query;
  obs["pg.query.name/length"] = [proto.name, proto.length];
  obs["pg.pool.query.name/length"] = [
    pg.Pool.prototype.query.name,
    pg.Pool.prototype.query.length,
  ];

  const p = client.query("SELECT 1 AS n");
  obs["pg.promise.isPromise"] = p instanceof Promise;
  obs["pg.promise"] = await settle(p.then((r) => r.rows));

  obs["pg.callback"] = await new Promise((resolve) => {
    let calls = 0;
    const ret = client.query(
      "SELECT 2 AS n",
      function (this: unknown, err, res) {
        calls++;
        setTimeout(() =>
          resolve({
            calls,
            err,
            rows: res?.rows,
            thisName: (this as object | undefined)?.constructor?.name,
            returned: ret,
          }),
        );
      },
    );
  });
  obs["pg.callback.values"] = await new Promise((resolve) =>
    client.query("SELECT $1::int AS n", [3], (err, res) =>
      resolve({ err, rows: res?.rows }),
    ),
  );
  obs["pg.config.object"] = await settle(
    client
      .query({ text: "SELECT $1::int AS n", values: [4] })
      .then((r) => r.rows),
  );
  obs["pg.config.callbackProp"] = await new Promise((resolve) => {
    const ret = client.query({
      text: "SELECT 5 AS n",
      callback: (err: unknown, res: pg.QueryResult) =>
        resolve({ err, rows: res?.rows, returned: typeof ret }),
    } as unknown as string);
  });

  try {
    client.query(null as unknown as string);
    obs["pg.null.sync"] = "no throw";
  } catch (e) {
    obs["pg.null.sync"] = describe(e);
  }
  obs["pg.error"] = await settle(client.query("SELECT * FROM nestrix_missing"));
  const errObj = await client
    .query("SELECT * FROM nestrix_missing")
    .catch((e) => e);
  obs["pg.error.isDatabaseError"] = errObj instanceof pg.DatabaseError;

  // Unawaited failing query: Node reports one unhandled rejection with pg's error.
  void client.query("SELECT * FROM nestrix_missing_unawaited");
  await waitFor(() => unhandled.length > 0);
  obs["pg.unawaited.unhandled"] = [...unhandled];
  unhandled.length = 0;

  // A user callback that throws: pg does not catch it, so it surfaces as uncaught.
  client.query("SELECT 6 AS n", () => {
    throw new Error("thrown by user callback");
  });
  await waitFor(() => uncaught.length > 0);
  obs["pg.callbackThrows.uncaught"] = [...uncaught];
  uncaught.length = 0;
  // pg leaves the client queryable after that?
  obs["pg.afterCallbackThrow"] = await settle(
    client.query("SELECT 7 AS n").then((r) => r.rows),
  );

  const cursor = client.query(new Cursor("SELECT generate_series(1, 5) AS n"));
  obs["pg.cursor.read"] = await cursor.read(2);
  obs["pg.cursor.read2"] = await cursor.read(10);
  await cursor.close();
  const stream = client.query(
    new QueryStream("SELECT generate_series(1, 3) AS n"),
  );
  obs["pg.stream.errorListenersAtSubmit"] = stream.listenerCount("error");
  const rows: unknown[] = [];
  for await (const r of stream) rows.push(r);
  obs["pg.stream"] = rows;
  const bad = client.query(new QueryStream("SELECT * FROM nestrix_missing"));
  obs["pg.stream.bad.errorListeners"] = bad.listenerCount("error");
  obs["pg.stream.bad"] = await new Promise((resolve) => {
    bad.on("error", (e) => resolve(describe(e)));
    bad.resume();
  });

  obs["pg.pool.promise"] = await settle(
    pool.query("SELECT 8 AS n").then((r) => r.rows),
  );
  obs["pg.pool.callback"] = await new Promise((resolve) =>
    pool.query("SELECT 9 AS n", (err, res) =>
      resolve({ err, rows: res?.rows }),
    ),
  );
  obs["pg.pool.error"] = await settle(
    pool.query("SELECT * FROM nestrix_missing"),
  );
  void pool.query("SELECT * FROM nestrix_missing_pool_unawaited");
  await waitFor(() => unhandled.length > 0);
  obs["pg.pool.unawaited.unhandled"] = [...unhandled];
  unhandled.length = 0;
  // pool.query with a reused config object, twice (marking must not leak).
  const cfg = { text: "SELECT 10 AS n" };
  obs["pg.pool.reusedConfig"] = [
    (await pool.query(cfg)).rows,
    (await client.query(cfg)).rows,
  ];
  await client.end();
  await pool.end();
}

async function mysqlChecks(url: string) {
  const conn = mysql.createConnection({ uri: url });
  const pool = mysqlPromise.createPool({ uri: url, connectionLimit: 1 });
  obs["mysql.callback.query"] = await new Promise((resolve) =>
    conn.query("SELECT 1 AS n", (err, rows) => resolve({ err, rows })),
  );
  obs["mysql.callback.execute"] = await new Promise((resolve) =>
    conn.execute("SELECT ? AS n", [2], (err, rows) => resolve({ err, rows })),
  );
  obs["mysql.callback.error"] = await new Promise((resolve) =>
    conn.query("SELECT * FROM nestrix_missing", (err) =>
      resolve(describe(err)),
    ),
  );
  obs["mysql.promise"] = await settle(
    pool.query("SELECT 3 AS n").then((r) => r[0]),
  );
  obs["mysql.promise.error"] = await settle(
    pool.query("SELECT * FROM nestrix_missing"),
  );
  void pool.query("SELECT * FROM nestrix_missing_unawaited");
  await waitFor(() => unhandled.length > 0);
  obs["mysql.unawaited.unhandled"] = [...unhandled];
  unhandled.length = 0;

  // Streaming (event-emitter) query, rows.
  obs["mysql.stream"] = await new Promise((resolve) => {
    const rows: unknown[] = [];
    conn
      .query("SELECT 4 AS n UNION SELECT 5")
      .stream()
      .on("data", (r: unknown) => rows.push(r))
      .on("end", () => resolve(rows))
      .on("error", (e: unknown) => resolve(describe(e)));
  });
  // Event-emitter query that fails with an 'error' listener attached.
  obs["mysql.emitter.error.withListener"] = await new Promise((resolve) => {
    const q = conn.query("SELECT * FROM nestrix_missing");
    q.on("error", (e: unknown) => resolve(describe(e)));
  });
  // Event-emitter query that fails with NO 'error' listener: what does the host see?
  const q = conn.query("SELECT * FROM nestrix_missing_no_listener");
  obs["mysql.emitter.noListener.listenerCountAfterSubmit"] =
    q.listenerCount("error");
  // Wait for the outcome instead of a fixed delay (a slow server made a 150 ms tick
  // flaky): either the error surfaced as uncaught, or the command ended. An 'end'
  // listener changes nothing about error handling.
  let ended = false;
  q.once("end", () => {
    ended = true;
  });
  for (let i = 0; i < 300 && !ended && uncaught.length === 0; i++) {
    await tick(10);
  }
  await tick(20);
  obs["mysql.emitter.noListener.uncaught"] = [...uncaught];
  obs["mysql.emitter.noListener.unhandled"] = [...unhandled];
  uncaught.length = 0;
  unhandled.length = 0;
  obs["mysql.afterNoListener"] = await new Promise((resolve) =>
    conn.query("SELECT 6 AS n", (err, rows) =>
      resolve({ err: describe(err), rows }),
    ),
  );
  await new Promise((r) => conn.end(r));
  await pool.end();
}

async function redisChecks(url: string) {
  // REDIS_LIB=ioredis5 runs the same checks on ioredis 5.11.1.
  const Ctor = (
    process.env.REDIS_LIB === "ioredis5" ? Redis5 : Redis
  ) as typeof Redis;
  obs["redis.lib"] = process.env.REDIS_LIB ?? "ioredis";
  const redis = new Ctor(url);
  await new Promise((r) => redis.once("ready", r));
  await redis.set("nestrix:q7", "v");
  await redis.set("nestrix:q7:str", "x");
  const p = redis.get("nestrix:q7");
  obs["redis.promise.isPromise"] = p instanceof Promise;
  obs["redis.promise"] = await settle(p);
  obs["redis.callback"] = await new Promise((resolve) => {
    let calls = 0;
    redis.get("nestrix:q7", (err, v) => {
      calls++;
      setTimeout(() => resolve({ calls, err, v }));
    });
  });
  obs["redis.error"] = await settle(redis.lpush("nestrix:q7:str", "y"));
  obs["redis.callback.error"] = await new Promise((resolve) =>
    redis.lpush("nestrix:q7:str", "y", (err) => resolve(describe(err))),
  );
  obs["redis.pipeline"] = await settle(
    redis.pipeline().get("nestrix:q7").lpush("nestrix:q7:str", "y").exec(),
  ).then((r) => JSON.stringify(r));
  obs["redis.multi"] = await settle(
    redis.multi().get("nestrix:q7").incr("nestrix:q7:n").exec(),
  ).then((r) => JSON.stringify(r).replace(/\d+\]\]/, "N]]"));
  // Unawaited failing command.
  void redis.lpush("nestrix:q7:str", "unawaited");
  await waitFor(() => unhandled.length > 0);
  obs["redis.unawaited.unhandled"] = [...unhandled];
  unhandled.length = 0;
  await redis.quit();
}

async function main() {
  const env = process.env;
  if (env.PG_URL) await pgChecks(env.PG_URL);
  if (env.MYSQL_URL) await mysqlChecks(env.MYSQL_URL);
  if (env.REDIS_URL) await redisChecks(env.REDIS_URL);
  await tick(50);
  obs["late.unhandled"] = [...unhandled];
  obs["late.uncaught"] = [...uncaught];
  const meta = {
    mode,
    node: process.version,
    execArgv: process.execArgv,
    failures,
    spanCount: finishedSpans().length,
  };
  // The mysql connection is left in a closed state by the no-listener case; exit
  // explicitly once the observations are written.
  process.stdout.write(`__Q7__${JSON.stringify({ meta, obs })}\n`, () =>
    process.exit(0),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
