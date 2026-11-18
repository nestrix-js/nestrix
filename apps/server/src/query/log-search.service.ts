/**
 * `GET /api/v1/logs` (issue #17, D-106): search over the stored log lines (`logs`, migration 0021),
 * newest first. A read of what the writer stored (`NESTRIX_LOGS` decides what that is), so it is
 * always available.
 *
 * - Scope: `service` and `environment` (D-101) through `scopeSql`, like every other query; a
 *   line's environment is its resource's, or its ingest key's (trace-less lines included).
 * - Window: `fromUnixMs` (default: 24 hours before now) to `toUnixMs` (default: open). The `time`
 *   column (the partition key) bounds the scan, so partitions outside the window are not read.
 * - `text`: `match=words` is PostgreSQL full text search (`to_tsvector('simple', body)`, GIN
 *   index, `websearch_to_tsquery`); `match=substring` is a case-insensitive ILIKE over the window.
 * - Paging: cursor on `(time_ns, trace_id, record_hash)`, the index order, so pages are stable
 *   while lines arrive. Cursor `l<time_ns>.<trace id or ->.<record hash>`; one that cannot be
 *   decoded is a 400.
 * - The statement is limited to `STATEMENT_TIMEOUT_MS`: a slow scan answers 503 asking for a
 *   narrower window.
 */
import { HttpException, Inject, Injectable } from "@nestjs/common";
import type {
  ApiError,
  LogSearchDropped,
  LogSearchRecord,
  LogSearchResponse,
} from "@nestrix-js/protocol";
import type pg from "pg";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import type { Values } from "./params.js";
import { scopeOf, scopeSql } from "./scope.js";

export const STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_WINDOW_MS = 24 * 3_600_000;
const SEVERITY_MIN: Record<string, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};
const CURSOR = /^l(\d{1,19})\.([0-9a-f]{0,32})\.([0-9a-f]{64})$/;

interface Position {
  timeNs: string;
  traceId: string;
  hash: string;
}

export function logCursor(p: Position): string {
  return `l${p.timeNs}.${p.traceId}.${p.hash}`;
}

export function decodeLogCursor(cursor: string): Position | undefined {
  const m = CURSOR.exec(cursor);
  if (m === null) return undefined;
  if (m[2] !== "" && m[2]?.length !== 32) return undefined;
  if (BigInt(m[1] as string) > 2n ** 63n - 1n) return undefined;
  return {
    timeNs: m[1] as string,
    traceId: m[2] as string,
    hash: m[3] as string,
  };
}

/** Escapes `\`, `%` and `_` for an ILIKE pattern written with `ESCAPE '\'`. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

function badRequest(message: string): HttpException {
  const body: ApiError = { error: { code: "bad_request", message } };
  return new HttpException(body, 400);
}

interface Row {
  trace_id: string;
  span_id: string | null;
  time_ns: string;
  record_hash: string;
  severity_number: number;
  severity_text: string;
  body: string;
  context: string | null;
  service_name: string;
  truncated: boolean;
  trace_exists: boolean;
}

@Injectable()
export class LogSearchService {
  constructor(
    @Inject(STORAGE_POOL) private readonly pool: pg.Pool,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async search(
    v: Values,
    nowMs: number = Date.now(),
  ): Promise<LogSearchResponse> {
    const values: unknown[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    const from =
      typeof v.fromUnixMs === "number"
        ? v.fromUnixMs
        : nowMs - DEFAULT_WINDOW_MS;
    const to = typeof v.toUnixMs === "number" ? v.toUnixMs : undefined;
    if (to !== undefined && to < from) {
      throw badRequest(
        'Query parameter "toUnixMs" must not be before "fromUnixMs".',
      );
    }
    const where: string[] = [`l.time >= to_timestamp(${add(from / 1000)})`];
    if (to !== undefined)
      where.push(`l.time <= to_timestamp(${add(to / 1000)})`);
    // The data scope (issue #28, D-101): service and environment, the way every query applies it.
    where.push(...scopeSql(scopeOf(v), add, "l"));
    if (typeof v.severity === "string") {
      where.push(`l.severity_number >= ${add(SEVERITY_MIN[v.severity])}`);
    }
    if (typeof v.traceId === "string")
      where.push(`l.trace_id = ${add(v.traceId)}`);
    if (typeof v.text === "string") {
      where.push(
        v.match === "substring"
          ? `l.body ILIKE ${add(likePattern(v.text))} ESCAPE '\\'`
          : `to_tsvector('simple', l.body) @@ websearch_to_tsquery('simple', ${add(v.text)})`,
      );
    }
    if (typeof v.before === "string") {
      const at = decodeLogCursor(v.before);
      if (at === undefined)
        throw badRequest('Query parameter "before" is not a valid cursor.');
      where.push(
        `(l.time_ns, l.trace_id, l.record_hash) < (${add(at.timeNs)}::bigint, ${add(at.traceId)}, ${add(at.hash)})`,
      );
    }
    const limit = typeof v.limit === "number" ? v.limit : 100;
    const sql = `SELECT l.trace_id, l.span_id, l.time_ns::text AS time_ns, l.record_hash,
              l.severity_number, l.severity_text, l.body, l.context, l.service_name, l.truncated,
              (l.trace_id <> '' AND EXISTS (SELECT 1 FROM traces t WHERE t.trace_id = l.trace_id))
                AS trace_exists
         FROM logs l
        WHERE ${where.join(" AND ")}
        ORDER BY l.time_ns DESC, l.trace_id DESC, l.record_hash DESC
        LIMIT ${add(limit + 1)}`;

    const client = await this.pool.connect();
    let rows: Row[];
    try {
      await client.query("BEGIN");
      await client.query(
        `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
      );
      rows = (await client.query<Row>(sql, values)).rows;
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is released below.
      }
      if ((error as { code?: string }).code === "57014") {
        const body: ApiError = {
          error: {
            code: "unavailable",
            message:
              "The log search took too long. Use a shorter time range or more filters.",
          },
        };
        throw new HttpException(body, 503);
      }
      throw error;
    } finally {
      client.release();
    }

    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const dropped = await this.dropped(from, to ?? nowMs);
    return {
      items: page.map(toRecord),
      older:
        more && last
          ? logCursor({
              timeNs: last.time_ns,
              traceId: last.trace_id,
              hash: last.record_hash,
            })
          : null,
      capture: this.config.logStore.mode,
      dropped,
    };
  }

  /** Drops counted on the UTC days the window touches (day granularity). */
  private async dropped(
    fromMs: number,
    toMs: number,
  ): Promise<LogSearchDropped> {
    const out: LogSearchDropped = {
      total: 0,
      rateCap: 0,
      traceCap: 0,
      outOfRange: 0,
    };
    try {
      const { rows } = await this.pool.query<{ reason: string; n: string }>(
        `SELECT reason, sum(dropped)::text AS n FROM log_drops
          WHERE day >= (to_timestamp($1) AT TIME ZONE 'UTC')::date
            AND day <= (to_timestamp($2) AT TIME ZONE 'UTC')::date
          GROUP BY reason`,
        [fromMs / 1000, toMs / 1000],
      );
      for (const r of rows) {
        const n = Number(r.n);
        if (r.reason === "rate_cap") out.rateCap = n;
        else if (r.reason === "trace_cap") out.traceCap = n;
        else if (r.reason === "out_of_range") out.outOfRange = n;
      }
      out.total = out.rateCap + out.traceCap + out.outOfRange;
    } catch {
      // The indicator is best effort; the lines themselves were read.
    }
    return out;
  }
}

function toRecord(r: Row): LogSearchRecord {
  const ns = BigInt(r.time_ns);
  const item: LogSearchRecord = {
    timeUnixMs: Number(ns / 1_000n) / 1_000,
    timeUnixNano: r.time_ns,
    severity: r.severity_number,
    level: r.severity_text,
    message: r.body,
    service: r.service_name,
    truncated: r.truncated,
  };
  if (r.context !== null) item.context = r.context;
  if (r.trace_id !== "") {
    item.traceId = r.trace_id;
    item.traceExists = r.trace_exists;
  }
  if (r.span_id !== null) item.spanId = r.span_id;
  return item;
}
