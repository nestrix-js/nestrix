// pg pool wait (issue #38, D-98) against a real PostgreSQL 18: the wait-time histogram, the
// connection-count and pending-request metrics, the `pg.pool.connect` span above the threshold,
// the wrapper's transparency (callback and promise forms, errors, `this`, shape) and rule 1 (an
// injected fault in any guarded body changes nothing).
// Global state: a host-style tracer provider with an in-memory exporter, the ALS context manager
// and W3C (outbound-helpers.ts), and a host-style MeterProvider with a pull reader registered
// globally. The pg integration is installed per describe block.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { metrics, SpanKind, trace } from "@opentelemetry/api";
import type { Histogram } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setIntegrationFaultForTests } from "../../src/integrations/db-span.js";
import { installIntegrations } from "../../src/integrations/index.js";
import {
  PG_POOL_CONNECT_SPAN,
  poolName,
  resetPgPoolsForTests,
} from "../../src/integrations/pg-pool.js";
import type { NestrixModuleOptions } from "../../src/options.js";
import { collect, hostMeterProvider, points } from "../metrics/fixture.js";
import { recordingDiagnostics } from "../otel-helpers.js";
import {
  closedPort,
  inParent,
  resolved,
  setupTestTracing,
} from "../outbound-helpers.js";
import {
  address,
  dbSpans,
  durationMs,
  parentId,
  skipReason,
  startMs,
  waitUntil,
} from "./helpers.js";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: pg is untyped here on purpose (structural use only)
const pg = require("pg") as any;
// The pg-pool class BoundPool extends: its `connect` is the unwrapped original.
const PgPool = require(
  require.resolve("pg-pool", {
    paths: [require.resolve("pg")],
  }),
);

const reason = skipReason("postgres");
const execFileAsync = promisify(execFile);
const pkgDir = fileURLToPath(new URL("../..", import.meta.url));
const distIndex = new URL("../../dist/integrations/index.js", import.meta.url)
  .href;
const distResolve = new URL("../../dist/resolve-options.js", import.meta.url)
  .href;
if (!existsSync(fileURLToPath(distIndex)))
  throw new Error(
    "pg-pool.test.ts needs `pnpm build` first (dist/integrations/index.js)",
  );
const { exporter } = setupTestTracing();
const host = hostMeterProvider();
metrics.setGlobalMeterProvider(host.provider);

function config(extra: Record<string, unknown> = {}) {
  const a = address("postgres");
  return {
    host: a.host,
    port: a.port,
    user: "postgres",
    database: "nestrix",
    ...extra,
  };
}

const connectSpans = (): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((s) => s.name === PG_POOL_CONNECT_SPAN);

function expectedName(): string {
  const a = address("postgres");
  return `${a.host}:${a.port}/nestrix`;
}

/** Histogram points of `db.client.connection.wait_time` for `name`, as count and sum (seconds). */
async function waits(name = expectedName()) {
  const rm = await collect(host.reader);
  const found = points(rm, "db.client.connection.wait_time").filter(
    (p) => p.attributes["db.client.connection.pool.name"] === name,
  );
  // Cumulative temporality: tests compare count and sum before and after.
  return {
    count: found.reduce((n, p) => n + (p.value as Histogram).count, 0),
    sum: found.reduce((n, p) => n + ((p.value as Histogram).sum ?? 0), 0),
  };
}

/** The live values of the count and pending metrics for `name`. */
async function gauges(name = expectedName()) {
  const rm = await collect(host.reader);
  const pick = (metric: string, state?: string) =>
    points(rm, metric).find(
      (p) =>
        p.attributes["db.client.connection.pool.name"] === name &&
        (state === undefined ||
          p.attributes["db.client.connection.state"] === state),
    )?.value;
  return {
    idle: pick("db.client.connection.count", "idle"),
    used: pick("db.client.connection.count", "used"),
    pending: pick("db.client.connection.pending_requests"),
  };
}

/** The SDK's anchored clock and `performance.timeOrigin` differ by a fraction of a millisecond. */
const CLOCK_SKEW_MS = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function install(options: NestrixModuleOptions = {}) {
  const diagnostics = recordingDiagnostics();
  const dispose = installIntegrations(resolved(options), diagnostics);
  return { diagnostics, dispose };
}

describe("poolName", () => {
  it("is host:port/database, IPv6 in brackets, never user or password", () => {
    expect(
      poolName({
        host: "db.internal",
        port: 5433,
        database: "app",
        user: "u",
        password: "secret",
      }),
    ).toBe("db.internal:5433/app");
    expect(
      poolName({ connectionParameters: { host: "::1", port: "5432" } }),
    ).toBe("[::1]:5432");
    expect(poolName({ host: "/var/run/postgresql", port: 5432 })).toBe(
      "/var/run/postgresql:5432",
    );
    expect(poolName({ port: 5432 })).toBeUndefined();
    expect(poolName(undefined)).toBeUndefined();
  });
});

describe.skipIf(reason !== undefined)(
  "pg pool wait against PostgreSQL 18",
  () => {
    let installed: ReturnType<typeof install>;

    beforeAll(async () => {
      installed = install();
      await waitUntil(
        async () => {
          const c = new pg.Client(config());
          await c.connect();
          await c.end();
        },
        30_000,
        "postgres",
      );
    }, 40_000);

    afterAll(() => installed?.dispose());

    afterEach(async () => {
      setIntegrationFaultForTests(undefined);
      resetPgPoolsForTests();
      exporter.reset();
      await collect(host.reader); // drain
    });

    it("wraps Pool.prototype.connect with the original's name and length, no Proxy", () => {
      const wrapped = pg.Pool.prototype.connect;
      const original = PgPool.prototype.connect;
      expect(wrapped).not.toBe(original);
      expect(wrapped.name).toBe(original.name);
      expect(wrapped.length).toBe(original.length);
      expect(wrapped[Symbol.for("nestrix.pg.wrapped")]).toBe(original);
      expect(Object.hasOwn(pg.Pool.prototype, "connect")).toBe(true);
    });

    it("acceptance: pool of 2, 10 concurrent transactions: waits in the metric and spans above 5 ms, query spans exclude the wait", async () => {
      const pool = new pg.Pool(config({ max: 2 }));
      const before = await waits();
      try {
        const requests = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            inParent(async () => {
              const client = await pool.connect();
              try {
                await client.query("BEGIN");
                await client.query("SELECT set_config('app.req', $1, true)", [
                  String(i),
                ]);
                await client.query("SELECT pg_sleep(0.03)");
                await client.query("COMMIT");
              } finally {
                client.release();
              }
            }),
          ),
        );
        const w = await waits();
        expect(w.count - before.count).toBe(10);
        // Eight of ten waited for at least one 30 ms transaction (two queued behind two or more).
        expect(w.sum - before.sum).toBeGreaterThanOrEqual(8 * 0.025);

        const found = connectSpans();
        // At least the eight that queued; the two that opened a connection may be above 5 ms too.
        expect(found.length).toBeGreaterThanOrEqual(8);
        expect(found.length).toBeLessThanOrEqual(10);
        const parents = new Map(
          requests.map((r) => [r.parent.spanContext().spanId, r.parent]),
        );
        for (const span of found) {
          expect(span.kind).toBe(SpanKind.INTERNAL);
          expect(durationMs(span)).toBeGreaterThanOrEqual(5);
          expect(span.attributes).toEqual({
            "db.client.connection.pool.name": expectedName(),
          });
          // Not a query: no db.system.name, so the dashboard does not count it.
          expect(span.attributes["db.system.name"]).toBeUndefined();
          const parent = parents.get(parentId(span) ?? "");
          expect(parent).toBeDefined();
          expect(span.spanContext().traceId).toBe(
            parent?.spanContext().traceId,
          );
          // D-59: the request's BEGIN span starts after the wait ended.
          const begin = dbSpans(exporter.getFinishedSpans()).find(
            (s) =>
              s.name === "BEGIN" &&
              s.spanContext().traceId === span.spanContext().traceId,
          );
          expect(begin).toBeDefined();
          if (begin !== undefined)
            expect(startMs(begin)).toBeGreaterThanOrEqual(
              startMs(span) + durationMs(span) - CLOCK_SKEW_MS,
            );
        }
        // One span per waiting request at most.
        expect(new Set(found.map(parentId)).size).toBe(found.length);
      } finally {
        await pool.end();
      }
    });

    it("pool.query: the queued call gets a pg.pool.connect span; its query span stays the query (D-59)", async () => {
      const pool = new pg.Pool(config({ max: 1 }));
      try {
        await pool.query("SELECT 1"); // open the connection first
        exporter.reset();
        const [a, b] = await Promise.all([
          inParent(() => pool.query("SELECT pg_sleep(0.1)")),
          inParent(() => pool.query("SELECT pg_sleep(0.1)")),
        ]);
        const found = connectSpans();
        expect(found).toHaveLength(1);
        const span = found[0] as ReadableSpan;
        expect(durationMs(span)).toBeGreaterThanOrEqual(80);
        const queued = [a, b].find(
          (r) => r.parent.spanContext().spanId === parentId(span),
        );
        expect(queued).toBeDefined();
        const query = dbSpans(exporter.getFinishedSpans()).find(
          (s) => parentId(s) === parentId(span),
        );
        expect(query).toBeDefined();
        if (query !== undefined) {
          expect(startMs(query)).toBeGreaterThanOrEqual(
            startMs(span) + durationMs(span) - CLOCK_SKEW_MS,
          );
        }
      } finally {
        await pool.end();
      }
    });

    it("a free client: no span and no event, the wait is still in the histogram", async () => {
      const pool = new pg.Pool(config({ max: 2 }));
      try {
        (await pool.connect()).release(); // one idle client
        exporter.reset();
        const before = await waits();
        for (let i = 0; i < 5; i++) {
          await inParent(async () => {
            const client = await pool.connect();
            await client.query("SELECT 1");
            client.release();
          });
          await inParent(() => pool.query("SELECT 1"));
        }
        expect(connectSpans()).toEqual([]);
        for (const s of exporter.getFinishedSpans())
          expect(s.events.map((e) => e.name)).not.toContain(
            PG_POOL_CONNECT_SPAN,
          );
        const w = await waits();
        expect(w.count - before.count).toBe(10);
        expect((w.sum - before.sum) / 10).toBeLessThan(0.005);
      } finally {
        await pool.end();
      }
    });

    it("count and pending metrics follow the pool: used, idle and queued callers", async () => {
      const pool = new pg.Pool(config({ max: 2 }));
      try {
        const held = [await pool.connect(), await pool.connect()];
        const queued = [pool.connect(), pool.connect(), pool.connect()];
        expect(await gauges()).toEqual({ idle: 0, used: 2, pending: 3 });
        for (const c of held) c.release();
        const next = await Promise.all(queued.slice(0, 2));
        expect(await gauges()).toEqual({ idle: 0, used: 2, pending: 1 });
        for (const c of next) c.release();
        (await queued[2]).release();
        expect(await gauges()).toEqual({ idle: 2, used: 0, pending: 0 });
        // An ended pool reports zero once (the SDK would keep its last counts otherwise).
        await pool.end();
        expect(await gauges()).toEqual({ idle: 0, used: 0, pending: 0 });
        expect(await gauges()).toEqual({ idle: 0, used: 0, pending: 0 });
      } finally {
        if (!pool.ended) await pool.end();
      }
    });

    it("two pools with the same name are summed", async () => {
      const one = new pg.Pool(config({ max: 1 }));
      const two = new pg.Pool(config({ max: 1 }));
      try {
        const a = await one.connect();
        const b = await two.connect();
        expect(await gauges()).toEqual({ idle: 0, used: 2, pending: 0 });
        a.release();
        b.release();
        expect(await gauges()).toEqual({ idle: 2, used: 0, pending: 0 });
      } finally {
        await one.end();
        await two.end();
      }
    });

    it("callback form: same arguments, same this, release works; waits recorded", async () => {
      const pool = new pg.Pool(config({ max: 1 }));
      try {
        const before = (await waits()).count;
        const seen = await new Promise<{
          args: number;
          self: { constructor?: { name?: string } } | undefined;
          err: unknown;
          rows: unknown;
        }>((resolve, reject) => {
          const ret = pool.connect(function (this: unknown, ...all: unknown[]) {
            const args = all.length;
            const [err, client, done] = all as [
              unknown,
              { query: (t: string) => Promise<{ rows: unknown }> },
              () => void,
            ];
            client
              .query("SELECT 1 AS n")
              .then((r) => {
                done();
                resolve({ args, self: this as never, err, rows: r.rows });
              })
              .catch(reject);
          });
          expect(ret).toBeUndefined();
        });
        expect(seen.err).toBeUndefined();
        expect(seen.args).toBe(3);
        // pg-pool calls `pendingItem.callback(...)`: the wrapper passes that `this` on as is.
        expect(seen.self?.constructor?.name).toBe("PendingItem");
        expect(seen.rows).toEqual([{ n: 1 }]);
        expect((await waits()).count - before).toBe(1);
      } finally {
        await pool.end();
      }
    });

    it("errors propagate unchanged and add no connect span; pool.query keeps its failure span", async () => {
      const pool = new pg.Pool({
        ...config(),
        port: await closedPort(),
        max: 1,
      });
      const before = (await waits()).count;
      try {
        const promised = await inParent(() =>
          pool.connect().then(
            () => undefined,
            (e: unknown) => e,
          ),
        );
        expect(promised.result).toBeInstanceOf(Error);
        expect((promised.result as { code?: string }).code).toBe(
          "ECONNREFUSED",
        );
        const viaCallback = await new Promise<unknown[]>((resolve) =>
          pool.connect((...args: unknown[]) => resolve(args)),
        );
        expect((viaCallback[0] as { code?: string }).code).toBe("ECONNREFUSED");
        const queried = await inParent(() =>
          pool.query("SELECT 1").then(
            () => undefined,
            (e: unknown) => e,
          ),
        );
        expect((queried.result as { code?: string }).code).toBe("ECONNREFUSED");
        expect(connectSpans()).toEqual([]);
        const failed = dbSpans(exporter.getFinishedSpans());
        expect(failed).toHaveLength(1);
        expect(failed[0]?.attributes["error.type"]).toBeDefined();
        expect((await waits()).count - before).toBe(0);
      } finally {
        await pool.end();
      }
      // An ended pool: pg-pool's own error, promise and (synchronous) callback forms.
      await expect(pool.connect()).rejects.toThrow(
        "Cannot use a pool after calling end on the pool",
      );
      let sync: unknown;
      pool.connect((e: unknown) => {
        sync = e;
      });
      expect(String(sync)).toContain("Cannot use a pool after calling end");
    });

    it("a rejection nobody handles is still reported once as unhandled (child process, built dist)", async () => {
      const port = await closedPort();
      const script = (install: boolean) => `
      const { installIntegrations } = await import(${JSON.stringify(distIndex)});
      const { resolveOptions } = await import(${JSON.stringify(distResolve)});
      const pg = (await import("pg")).default;
      if (${install}) installIntegrations(resolveOptions({}, {}), { logOnce() {}, countFailure() {} });
      const seen = [];
      process.on("unhandledRejection", (r) => seen.push(r.code));
      const pool = new pg.Pool({ host: "127.0.0.1", port: ${port}, max: 1 });
      pool.connect();
      await new Promise((r) => setTimeout(r, 300));
      console.log(JSON.stringify(seen));
      await pool.end();
    `;
      const run = (install: boolean) =>
        execFileAsync(
          process.execPath,
          ["--input-type=module", "-e", script(install)],
          {
            cwd: pkgDir,
            timeout: 20_000,
          },
        ).then((r) => JSON.parse(r.stdout.trim()));
      expect(await run(false)).toEqual(["ECONNREFUSED"]);
      expect(await run(true)).toEqual(["ECONNREFUSED"]);
    });

    it("outside a trace: the wait is measured, no span", async () => {
      const pool = new pg.Pool(config({ max: 1 }));
      try {
        const first = await pool.connect();
        const before = await waits();
        const queued = pool.connect();
        await sleep(20);
        first.release();
        (await queued).release();
        expect(trace.getActiveSpan()).toBeUndefined();
        expect(connectSpans()).toEqual([]);
        expect((await waits()).sum - before.sum).toBeGreaterThanOrEqual(0.015);
      } finally {
        await pool.end();
      }
    });

    it.each(["pg.pool.connect", "pg.pool.connect.settle", "pg.pool.observe"])(
      "rule 1: a fault at %s changes nothing and is counted",
      async (site) => {
        const failuresBefore = installed.diagnostics.failures.length;
        setIntegrationFaultForTests((at) => {
          if (at === site) throw new Error(`fault at ${at}`);
        });
        const pool = new pg.Pool(config({ max: 1 }));
        try {
          const first = await pool.connect();
          const queued = inParent(() => pool.query("SELECT 2 AS n"));
          await sleep(10);
          const { errors } = await host.reader.collect();
          expect(errors).toEqual([]);
          first.release();
          const { result } = await queued;
          expect(result.rows).toEqual([{ n: 2 }]);
          const viaCallback = await new Promise<unknown[]>((resolve) =>
            pool.connect((...args: unknown[]) => {
              (args[2] as () => void)();
              resolve(args);
            }),
          );
          expect(viaCallback[0]).toBeUndefined();
          expect(installed.diagnostics.failures.length).toBeGreaterThan(
            failuresBefore,
          );
          expect(
            installed.diagnostics.failures
              .slice(failuresBefore)
              .every((f) => String(f.error).includes(`fault at ${site}`)),
          ).toBe(true);
        } finally {
          setIntegrationFaultForTests(undefined);
          await pool.end();
        }
      },
    );
  },
);

describe.skipIf(reason !== undefined)("pool wait options", () => {
  afterEach(async () => {
    resetPgPoolsForTests();
    exporter.reset();
    await collect(host.reader);
  });

  /** Warms a one-client pool outside any trace, then, in a trace, one free and one queued acquisition. */
  async function queuedWait(): Promise<void> {
    const pool = new pg.Pool(config({ max: 1 }));
    try {
      (await pool.connect()).release(); // a new connection can take over 5 ms: not in the trace
      await inParent(async () => {
        const first = await pool.connect();
        const queued = pool.connect();
        await sleep(20);
        first.release();
        (await queued).release();
      });
    } finally {
      await pool.end();
    }
  }

  it("poolWaitThresholdMillis: false adds no span, metrics stay", async () => {
    const { dispose } = install({
      integrations: { pg: { poolWaitThresholdMillis: false } },
    });
    try {
      const before = (await waits()).count;
      await queuedWait();
      expect(connectSpans()).toEqual([]);
      expect((await waits()).count - before).toBe(3);
    } finally {
      dispose();
    }
  });

  it("poolWaitThresholdMillis: 0 adds a span for every acquisition in a trace", async () => {
    const { dispose } = install({
      integrations: { pg: { poolWaitThresholdMillis: 0 } },
    });
    try {
      await queuedWait();
      expect(connectSpans()).toHaveLength(2);
    } finally {
      dispose();
    }
  });

  it("metrics: false records no pool metric, spans stay", async () => {
    // A fresh provider: the shared reader keeps cumulative points from earlier tests.
    const fresh = hostMeterProvider();
    metrics.disable();
    metrics.setGlobalMeterProvider(fresh.provider);
    const { dispose } = install({ metrics: false });
    try {
      await queuedWait();
      const rm = await collect(fresh.reader);
      expect(
        points(rm, "db.client.connection.wait_time").length +
          points(rm, "db.client.connection.count").length +
          points(rm, "db.client.connection.pending_requests").length,
      ).toBe(0);
      expect(connectSpans()).toHaveLength(1);
    } finally {
      dispose();
      metrics.disable();
      metrics.setGlobalMeterProvider(host.provider);
    }
  });

  it("disposed: connect passes straight through", async () => {
    const { dispose } = install();
    dispose();
    const pool = new pg.Pool(config({ max: 1 }));
    try {
      await inParent(async () => (await pool.connect()).release());
      expect(connectSpans()).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
