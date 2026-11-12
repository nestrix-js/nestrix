/**
 * `GET /api/v1/trace/logs?id=` (P9-07): the log lines stored next to a trace (`src/storage/logs.ts`),
 * oldest first, in the embedded dashboard's `TraceLogsResponse` shape. A trace with none answers no
 * items. `truncated` is true when the trace holds the per-trace maximum (the writer stores no more
 * after that, so later lines may have been dropped).
 */
import { Inject, Injectable } from "@nestjs/common";
import type { TraceLogRecord, TraceLogsResponse } from "@nestrix-js/protocol";
import type pg from "pg";
import { MAX_LOGS_PER_TRACE } from "../storage/logs.js";
import { STORAGE_POOL } from "../storage/storage.module.js";

interface LogRow {
  span_id: string | null;
  time_ns: string;
  severity_number: number;
  severity_text: string;
  body: string;
  context: string | null;
  service_name: string;
}

@Injectable()
export class TraceLogsService {
  constructor(@Inject(STORAGE_POOL) private readonly pool: pg.Pool) {}

  async getTraceLogs(traceId: string): Promise<TraceLogsResponse> {
    const { rows } = await this.pool.query<LogRow>(
      `SELECT span_id, time_ns::text AS time_ns, severity_number, severity_text, body, context,
              service_name
         FROM logs WHERE trace_id = $1
        ORDER BY time_ns, record_hash
        LIMIT $2`,
      [traceId, MAX_LOGS_PER_TRACE],
    );
    const items = rows.map((r): TraceLogRecord => {
      const item: TraceLogRecord = {
        timeUnixMs: Number(BigInt(r.time_ns) / 1_000n) / 1_000,
        severity: r.severity_number,
        level: r.severity_text,
        message: r.body,
        service: r.service_name,
      };
      if (r.context !== null) item.context = r.context;
      if (r.span_id !== null) item.spanId = r.span_id;
      return item;
    });
    return {
      traceId,
      items,
      truncated: items.length >= MAX_LOGS_PER_TRACE,
    };
  }
}
