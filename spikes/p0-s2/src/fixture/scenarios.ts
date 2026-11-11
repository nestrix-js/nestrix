import { trace } from "@opentelemetry/api";
import type { Redis } from "ioredis";
import mysql from "mysql2";
import mysqlPromise from "mysql2/promise";
import pg from "pg";
import Cursor from "pg-cursor";
import QueryStream from "pg-query-stream";

// The app's own imports of the drivers (ESM default import of CommonJS `pg`), as an
// application would write them. The stand-in Nestrix package resolves `pg` on its own.

export interface Tagged<T> {
  spanId: string;
  traceId: string;
  result: T;
}

const tracer = trace.getTracer("fixture-app");

/** Runs fn inside an active span, as a Nest handler would run inside the server span. */
export function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<Tagged<T>> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      const { spanId, traceId } = span.spanContext();
      return { spanId, traceId, result };
    } finally {
      span.end();
    }
  });
}

const errText = (e: unknown) =>
  e instanceof Error
    ? `${(e as { code?: string }).code ?? e.name}: ${e.message}`
    : String(e);

export async function pgScenario(url: string) {
  const client = new pg.Client({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await client.connect();
  try {
    return await withSpan("handler pg", async () => {
      const out: Record<string, unknown> = {};
      out.clientPromise = (await client.query("SELECT $1::int AS n", [1])).rows;
      out.clientCallback = await new Promise((resolve, reject) =>
        client.query("SELECT 2 AS n", (err, res) =>
          err ? reject(err) : resolve(res.rows),
        ),
      );
      out.poolPromise = (await pool.query("SELECT 3 AS n")).rows;
      out.poolCallback = await new Promise((resolve, reject) =>
        pool.query("SELECT 4 AS n", [], (err, res) =>
          err ? reject(err) : resolve(res.rows),
        ),
      );
      try {
        await client.query("SELECT * FROM nestrix_missing_table");
      } catch (e) {
        out.error = errText(e);
      }
      const cursor = client.query(
        new Cursor("SELECT generate_series(1, 5) AS n"),
      );
      out.cursor = await cursor.read(2);
      await cursor.close();
      const stream = client.query(
        new QueryStream("SELECT generate_series(1, 3) AS n"),
      );
      const streamed: unknown[] = [];
      for await (const row of stream) streamed.push(row);
      out.stream = streamed;
      return out;
    });
  } finally {
    await client.end();
    await pool.end();
  }
}

/** Two handlers share a one-connection pool, so the second waits for the first's release. */
export async function pgContention(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const [a, b] = await Promise.all([
      withSpan("handler pg A", () => pool.query("SELECT pg_sleep(0.1), 'a'")),
      withSpan("handler pg B", () => pool.query("SELECT pg_sleep(0.1), 'b'")),
    ]);
    return { a: a.spanId, b: b.spanId, traceA: a.traceId, traceB: b.traceId };
  } finally {
    await pool.end();
  }
}

export async function mysqlScenario(url: string) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 2 });
  const conn = mysql.createConnection({ uri: url });
  const ppool = mysqlPromise.createPool({ uri: url, connectionLimit: 1 });
  try {
    return await withSpan("handler mysql", async () => {
      const q = <T>(fn: (cb: (e: unknown, r: T) => void) => void) =>
        new Promise<T>((resolve, reject) =>
          fn((e, r) => (e ? reject(e) : resolve(r))),
        );
      const out: Record<string, unknown> = {};
      out.poolQuery = await q((cb) => pool.query("SELECT 1 AS n", cb));
      out.poolExecute = await q((cb) => pool.execute("SELECT ? AS n", [2], cb));
      out.connQuery = await q((cb) => conn.query("SELECT 3 AS n", cb));
      out.connExecute = await q((cb) => conn.execute("SELECT ? AS n", [4], cb));
      const [rows] = await ppool.query("SELECT 5 AS n");
      out.promisePool = rows;
      try {
        await ppool.query("SELECT * FROM nestrix_missing_table");
      } catch (e) {
        out.error = errText(e);
      }
      return out;
    });
  } finally {
    await new Promise((r) => pool.end(r));
    await new Promise((r) => conn.end(r));
    await ppool.end();
  }
}

export async function mysqlContention(url: string) {
  const pool = mysqlPromise.createPool({ uri: url, connectionLimit: 1 });
  try {
    const [a, b] = await Promise.all([
      withSpan("handler mysql A", () => pool.query("SELECT SLEEP(0.1), 'a'")),
      withSpan("handler mysql B", () => pool.query("SELECT SLEEP(0.1), 'b'")),
    ]);
    return { a: a.spanId, b: b.spanId };
  } finally {
    await pool.end();
  }
}

/**
 * Review F4: pool.getConnection callbacks that do their query on a later tick. The
 * pool:connect bracket covers only work started synchronously inside the callback.
 */
export async function mysqlCallbackLater(url: string) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 1 });
  const work = (label: string) =>
    withSpan(
      `handler mysql later ${label}`,
      () =>
        new Promise<void>((resolve, reject) =>
          pool.getConnection((err, conn) => {
            if (err) return reject(err);
            setImmediate(() =>
              conn.query(`SELECT SLEEP(0.05), '${label}'`, (e) => {
                conn.release();
                return e ? reject(e) : resolve();
              }),
            );
          }),
        ),
    );
  try {
    const [a, b] = await Promise.all([work("a"), work("b")]);
    return { a: a.spanId, b: b.spanId };
  } finally {
    await new Promise((r) => pool.end(r));
  }
}

export async function redisScenario(url: string, RedisCtor: typeof Redis) {
  const ready = new RedisCtor(url);
  await new Promise((r) => ready.once("ready", r));
  try {
    const main = await withSpan("handler redis", async () => {
      const out: Record<string, unknown> = {};
      out.set = await ready.set("nestrix:s2", "secret-value");
      out.get = await ready.get("nestrix:s2");
      out.callback = await new Promise((resolve, reject) =>
        ready.get("nestrix:s2", (e, v) => (e ? reject(e) : resolve(v))),
      );
      await ready.set("nestrix:s2:str", "x");
      try {
        await ready.lpush("nestrix:s2:str", "y");
      } catch (e) {
        out.error = errText(e);
      }
      out.pipeline = await ready.pipeline().get("nestrix:s2").incr("n").exec();
      return out;
    });
    // First command on a client that is not connected yet: queued offline.
    const fresh = new RedisCtor(url);
    const offline = await withSpan("handler redis offline", async () =>
      fresh.get("nestrix:s2"),
    );
    await fresh.quit();
    return { main, offline: offline.spanId };
  } finally {
    await ready.quit();
  }
}
