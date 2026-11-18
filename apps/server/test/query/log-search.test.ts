/**
 * Issue #17, D-106 against PostgreSQL: `NESTRIX_LOGS` decides what is stored; `GET /api/v1/logs`
 * searches it by service, level, text and time, in stable cursor pages, with drops counted.
 */
import "reflect-metadata";
import type { LogSearchResponse } from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  IngestLogBatch,
  IngestLogRecord,
} from "../../src/ingest/model.js";
import {
  decodeLogCursor,
  likePattern,
} from "../../src/query/log-search.service.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import {
  createTestDb,
  hex,
  noDatabase,
  nsAt,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import { type QueryServer, startQueryServer } from "./helpers.js";

function batch(
  records: IngestLogRecord[],
  service = "shop",
  environment?: string,
): IngestLogBatch {
  const resource: Record<string, string> = { "service.name": service };
  if (environment !== undefined) {
    resource["deployment.environment.name"] = environment;
  }
  return {
    resourceLogs: [{ resource, records }],
    rejectedLogRecords: 0,
  };
}

function line(i: number, over: Partial<IngestLogRecord> = {}): IngestLogRecord {
  return {
    traceId: "",
    timeUnixNano: nsAt(Date.now() - 60_000) + BigInt(i) * 1_000_000n,
    severityNumber: 9,
    severityText: "INFO",
    body: `line ${i}`,
    ...over,
  };
}

describe("cursor helpers", () => {
  it("decodes only well formed cursors", () => {
    const hash = "a".repeat(64);
    expect(decodeLogCursor(`l123..${hash}`)).toEqual({
      timeNs: "123",
      traceId: "",
      hash,
    });
    expect(decodeLogCursor(`l123.${hex(16)}.${hash}`)?.traceId).toHaveLength(
      32,
    );
    for (const bad of ["", "x", `l1.zz.${hash}`, `l1.ab.${hash}`, `l1..abc`]) {
      expect(decodeLogCursor(bad)).toBeUndefined();
    }
  });
  it("escapes ILIKE wildcards", () => {
    expect(likePattern("50%_a\\")).toBe("%50\\%\\_a\\\\%");
  });
});

describe.skipIf(noDatabase)(
  `log search, trace mode (default) ${skipReason}`,
  () => {
    let db: TestDb;
    let server: QueryServer;
    beforeAll(async () => {
      db = await createTestDb("logsearcht");
      server = await startQueryServer(db.url);
    });
    afterAll(async () => {
      await server?.close();
      await db?.drop();
    });

    it("drops lines without a trace, keeps 200 per trace, searches what is stored", async () => {
      const sink = server.app.get(PostgresIngestSink);
      const trace = hex(16);
      await sink.writeLogs(
        batch([
          line(0),
          ...Array.from({ length: 205 }, (_, i) => line(i, { traceId: trace })),
        ]),
      );
      const res = await server.json<LogSearchResponse>(
        "/api/v1/logs?limit=200",
      );
      expect(res.capture).toBe("trace");
      expect(res.items).toHaveLength(200);
      expect(res.items.every((i) => i.traceId === trace)).toBe(true);
      expect(res.older).toBeNull();
      expect(res.dropped.traceCap).toBe(5);
      expect(res.dropped.total).toBe(5);
    });
  },
);

describe.skipIf(noDatabase)(`log search, all mode ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  let sink: PostgresIngestSink;
  const search = (q: string) =>
    server.json<LogSearchResponse>(`/api/v1/logs${q}`);

  beforeAll(async () => {
    db = await createTestDb("logsearcha");
    server = await startQueryServer(db.url, true, true, {
      NESTRIX_LOGS: "all",
      NESTRIX_LOGS_MAX_PER_TRACE: "300",
    });
    sink = server.app.get(PostgresIngestSink);
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("stores traceless lines and lifts the per-trace cap", async () => {
    const trace = hex(16);
    await sink.writeLogs(
      batch([
        ...Array.from({ length: 250 }, (_, i) =>
          line(i, { traceId: trace, body: `traced ${i}` }),
        ),
        line(900, { body: "worker started" }),
      ]),
    );
    const res = await search(`?traceId=${trace}&limit=200`);
    expect(res.capture).toBe("all");
    expect(res.items).toHaveLength(200);
    expect(res.older).not.toBeNull();
    const rest = await search(
      `?traceId=${trace}&limit=200&before=${res.older}`,
    );
    expect(rest.items).toHaveLength(50);
    const none = await search("?text=worker");
    expect(none.items).toHaveLength(1);
    expect(none.items[0]?.traceId).toBeUndefined();
    expect(none.items[0]?.traceExists).toBeUndefined();
  });

  it("filters by service, level, text, time and trace; pages are stable under new lines", async () => {
    const t0 = Date.now() - 600_000;
    const at = (ms: number) => nsAt(t0 + ms);
    await sink.writeLogs(
      batch(
        [
          line(0, {
            timeUnixNano: at(0),
            severityNumber: 17,
            severityText: "ERROR",
            body: "ECONNREFUSED 10.0.0.1:5432",
          }),
          line(1, {
            timeUnixNano: at(1000),
            severityNumber: 13,
            severityText: "WARN",
            body: "slow connection pool",
          }),
          line(2, {
            timeUnixNano: at(2000),
            severityNumber: 9,
            severityText: "INFO",
            body: "100% done_ok",
          }),
          line(3, {
            timeUnixNano: at(3000),
            severityNumber: 9,
            severityText: "INFO",
            body: "x".repeat(50),
            truncated: true,
          }),
        ],
        "billing",
      ),
    );
    const from = t0 - 1;
    const base = `fromUnixMs=${from}&toUnixMs=${t0 + 10_000}`;

    const billing = await search(`?service=billing&${base}`);
    expect(billing.items.map((i) => i.service)).toEqual([
      "billing",
      "billing",
      "billing",
      "billing",
    ]);
    expect(billing.items.map((i) => i.timeUnixMs)).toEqual(
      [...billing.items.map((i) => i.timeUnixMs)].sort((a, b) => b - a),
    );
    expect((await search(`?service=shop&${base}`)).items).toHaveLength(0);

    const warn = await search(`?service=billing&severity=warn&${base}`);
    expect(warn.items.map((i) => i.level)).toEqual(["WARN", "ERROR"]);
    expect(
      (await search(`?service=billing&severity=error&${base}`)).items,
    ).toHaveLength(1);

    const words = await search(`?text=ECONNREFUSED&${base}`);
    expect(words.items).toHaveLength(1);
    expect(
      (await search(`?text=connection&${base}`)).items[0]?.message,
    ).toMatch(/slow/);
    expect((await search(`?text=conn&${base}`)).items).toHaveLength(0);
    expect(
      (await search(`?text=conn&match=substring&${base}`)).items,
    ).toHaveLength(2);
    // Wildcards in the text are literal.
    expect(
      (
        await search(
          `?text=${encodeURIComponent("100%")}&match=substring&${base}`,
        )
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await search(
          `?text=${encodeURIComponent("1_0")}&match=substring&${base}`,
        )
      ).items,
    ).toHaveLength(0);

    const cut = await search(`?service=billing&${base}`);
    expect(cut.items[0]?.truncated).toBe(true);
    expect(cut.items[1]?.truncated).toBe(false);

    // Time window: only the first two lines.
    const early = await search(
      `?service=billing&fromUnixMs=${from}&toUnixMs=${t0 + 1000}`,
    );
    expect(early.items.map((i) => i.level)).toEqual(["WARN", "ERROR"]);

    // Paging: 2 + 2, then a new, newer line must not shift the next page.
    const p1 = await search(`?service=billing&limit=2&${base}`);
    expect(p1.items).toHaveLength(2);
    await sink.writeLogs(
      batch([line(9, { timeUnixNano: at(9000), body: "late" })], "billing"),
    );
    const p2 = await search(
      `?service=billing&limit=2&before=${p1.older}&${base}`,
    );
    expect(p2.items.map((i) => i.level)).toEqual(["WARN", "ERROR"]);
    expect(p2.older).toBeNull();
  });

  it("scopes by environment like every query (D-101), trace-less lines included", async () => {
    const trace = hex(16);
    await sink.writeLogs(
      batch([line(1, { body: "envscope alpha" })], "envsvc", "staging"),
    );
    await sink.writeLogs(
      batch(
        [line(2, { body: "envscope beta", traceId: trace })],
        "envsvc",
        "production",
      ),
    );
    await sink.writeLogs(
      batch([line(3, { body: "envscope gamma" })], "envsvc"),
    );
    const bodies = async (q: string) =>
      (await search(`?text=envscope${q}`)).items.map((i) => i.message).sort();
    expect(await bodies("")).toEqual([
      "envscope alpha",
      "envscope beta",
      "envscope gamma",
    ]);
    expect(await bodies("&environment=staging")).toEqual(["envscope alpha"]);
    expect(await bodies("&environment=production")).toEqual(["envscope beta"]);
    expect(await bodies("&environment=unset")).toEqual(["envscope gamma"]);
    expect(await bodies("&environment=staging&service=envsvc")).toEqual([
      "envscope alpha",
    ]);
    expect(await bodies("&environment=staging&service=other")).toEqual([]);
    expect(await bodies("&environment=nowhere")).toEqual([]);
    const stored = await db.pool.query<{ environment: string | null }>(
      "SELECT environment FROM logs WHERE body LIKE 'envscope%' ORDER BY body",
    );
    expect(stored.rows.map((r) => r.environment)).toEqual([
      "staging",
      "production",
      null,
    ]);
  });

  it("flags whether the trace exists", async () => {
    const known = hex(16);
    const ghost = hex(16);
    await sink.write({
      resourceSpans: [
        {
          resource: { "service.name": "shop" },
          spans: [
            {
              traceId: known,
              spanId: hex(8),
              name: "GET /",
              kind: "server",
              startTimeUnixNano: nsAt(Date.now() - 5000),
              endTimeUnixNano: nsAt(Date.now() - 4990),
              attributes: {},
              events: [],
              links: [],
              status: { code: "unset" },
              scope: "t",
            },
          ],
        },
      ],
      rejectedSpans: 0,
    } as never);
    await sink.writeLogs(
      batch(
        [
          line(1, { traceId: known, body: "has trace" }),
          line(2, { traceId: ghost, body: "no trace stored" }),
        ],
        "exists",
      ),
    );
    const res = await search("?service=exists");
    const byBody = new Map(res.items.map((i) => [i.message, i.traceExists]));
    expect(byBody.get("has trace")).toBe(true);
    expect(byBody.get("no trace stored")).toBe(false);
  });

  it("answers 400 for a bad cursor, window or parameter", async () => {
    for (const q of [
      "?before=nope",
      "?fromUnixMs=5&toUnixMs=1",
      "?severity=loud",
      "?traceId=zz",
      "?limit=0",
      "?nope=1",
    ]) {
      expect((await server.get(`/api/v1/logs${q}`)).status).toBe(400);
    }
  });

  it("is closed to anyone who is not signed in", async () => {
    const closed = await startQueryServer(db.url, true, false);
    try {
      expect((await closed.get("/api/v1/logs")).status).toBe(401);
    } finally {
      await closed.close();
    }
  });
});

describe.skipIf(noDatabase)(`log rate cap ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  beforeAll(async () => {
    db = await createTestDb("logsearchr");
    server = await startQueryServer(db.url, true, true, {
      NESTRIX_LOGS: "all",
      NESTRIX_LOGS_MAX_PER_MINUTE: "10",
    });
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("stores at most the per-minute budget and counts the rest", async () => {
    const sink = server.app.get(PostgresIngestSink);
    await sink.writeLogs(batch(Array.from({ length: 25 }, (_, i) => line(i))));
    const res = await server.json<LogSearchResponse>("/api/v1/logs?limit=200");
    expect(res.items).toHaveLength(10);
    expect(res.dropped.rateCap).toBe(15);
    expect(res.dropped.total).toBe(15);
  });
});

describe.skipIf(noDatabase)(`log rate budget ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  beforeAll(async () => {
    db = await createTestDb("logsearchb");
    server = await startQueryServer(db.url, true, true, {
      NESTRIX_LOGS: "all",
      NESTRIX_LOGS_MAX_PER_MINUTE: "10",
    });
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("does not spend the budget on a retried export that stores nothing", async () => {
    const sink = server.app.get(PostgresIngestSink);
    const first = Array.from({ length: 5 }, (_, i) =>
      line(i, { body: `first ${i}` }),
    );
    await sink.writeLogs(batch(first));
    await sink.writeLogs(batch(first)); // the same payload again: all duplicates
    await sink.writeLogs(
      batch(
        Array.from({ length: 5 }, (_, i) => line(i, { body: `second ${i}` })),
      ),
    );
    const res = await server.json<LogSearchResponse>("/api/v1/logs?limit=200");
    expect(res.items).toHaveLength(10);
    expect(res.dropped.rateCap).toBe(0);
  });
});
