import { Inject, Injectable } from "@nestjs/common";
import type { Slo } from "@nestrix/protocol";
import type { Pool } from "pg";
import { rangeTotals } from "../alerts/metrics.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { computeStatus, type SloRow } from "./compute.js";
import { type SloFields, toApiSlo } from "./store.js";

const COLUMNS: (keyof SloFields)[] = [
  "name",
  "service_name",
  "route",
  "kind",
  "latency_threshold_ms",
  "objective",
  "window_days",
];

const HOUR_MS = 3_600_000;

/** SLOs in Postgres, with their status computed from the route rollups on every read. */
@Injectable()
export class SlosService {
  constructor(@Inject(STORAGE_POOL) private readonly pool: Pool) {}

  /** The SLO's status as of `nowMs` (the SLO's window, 1 h and 6 h, each ending at `nowMs`). */
  async withStatus(row: SloRow, nowMs = Date.now()): Promise<Slo> {
    const range = (ms: number) =>
      rangeTotals(this.pool, row.service_name, row.route, nowMs - ms, nowMs);
    const [window, h1, h6] = await Promise.all([
      range(row.window_days * 86_400_000),
      range(HOUR_MS),
      range(6 * HOUR_MS),
    ]);
    return toApiSlo(row, computeStatus(row, window, h1, h6));
  }

  async list(): Promise<Slo[]> {
    const { rows } = await this.pool.query<SloRow>(
      "SELECT * FROM slos ORDER BY id",
    );
    const nowMs = Date.now();
    return Promise.all(rows.map((r) => this.withStatus(r, nowMs)));
  }

  async row(id: number): Promise<SloRow | undefined> {
    const { rows } = await this.pool.query<SloRow>(
      "SELECT * FROM slos WHERE id = $1",
      [id],
    );
    return rows[0];
  }

  async get(id: number): Promise<Slo | undefined> {
    const row = await this.row(id);
    return row === undefined ? undefined : this.withStatus(row);
  }

  async create(fields: SloFields): Promise<Slo> {
    const names = COLUMNS.filter((c) => fields[c] !== undefined);
    const { rows } = await this.pool.query<SloRow>(
      `INSERT INTO slos (${names.join(", ")})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      names.map((c) => fields[c]),
    );
    return this.withStatus(rows[0] as SloRow);
  }

  async update(id: number, fields: SloFields): Promise<Slo | undefined> {
    const names = COLUMNS.filter((c) => fields[c] !== undefined);
    const { rows } = await this.pool.query<SloRow>(
      `UPDATE slos SET ${names.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, ...names.map((c) => fields[c])],
    );
    return rows[0] === undefined ? undefined : this.withStatus(rows[0]);
  }

  /** Also deletes the burn-rate rules that reference it (ON DELETE CASCADE). */
  async remove(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM slos WHERE id = $1",
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
}
