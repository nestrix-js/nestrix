import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import type {
  IngestBatch,
  IngestSpan,
  IngestSpanKind,
} from "../../src/ingest/model.js";

export const adminUrl = inject("pgAdminUrl");
export const skipReason = inject("pgSkipReason");
export const noDatabase = adminUrl === "";

export interface TestDb {
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

/** A fresh database for one test file (files run in parallel against the one container). */
export async function createTestDb(prefix: string): Promise<TestDb> {
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = adminUrl.replace(/\/postgres$/, `/${name}`);
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  pool.on("error", () => undefined);
  return {
    url,
    pool,
    async drop() {
      await pool.end().catch(() => undefined);
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

const MS = 1_000_000n;

export function nsAt(unixMs: number): bigint {
  return BigInt(Math.floor(unixMs)) * MS;
}

export interface SpanInit {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: IngestSpanKind;
  startMs: number;
  durationMs: number;
  attributes?: IngestSpan["attributes"];
  status?: IngestSpan["status"];
  events?: IngestSpan["events"];
}

export function span(init: SpanInit): IngestSpan {
  const start = nsAt(init.startMs);
  const s: IngestSpan = {
    traceId: init.traceId,
    spanId: init.spanId ?? hex(8),
    name: init.name ?? "span",
    kind: init.kind ?? "internal",
    startTimeUnixNano: start,
    endTimeUnixNano: start + BigInt(Math.round(init.durationMs * 1e6)),
    attributes: init.attributes ?? {},
    events: init.events ?? [],
    links: [],
    status: init.status ?? { code: "unset" },
    scope: "test",
  };
  if (init.parentSpanId !== undefined) s.parentSpanId = init.parentSpanId;
  return s;
}

export function batch(
  service: string,
  spans: IngestSpan[],
  resource: Record<string, string> = {},
): IngestBatch {
  return {
    resourceSpans: [
      { resource: { "service.name": service, ...resource }, spans },
    ],
    rejectedSpans: 0,
  };
}
