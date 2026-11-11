import { Injectable } from "@nestjs/common";
import { pool } from "./db.js";

export interface Order {
  id: number;
  customer_id: number;
  total: string;
  status: string;
}

@Injectable()
export class OrdersRepository {
  async recent(limit: number): Promise<Order[]> {
    const r = await pool.query<Order>(
      "SELECT id, customer_id, total, status FROM orders ORDER BY id DESC LIMIT $1",
      [limit],
    );
    return r.rows;
  }

  /** Called once per order by the service: the N+1 pattern the dashboard groups. */
  async customerName(id: number): Promise<string> {
    const r = await pool.query<{ name: string }>(
      "SELECT name FROM customers WHERE id = $1",
      [id],
    );
    return r.rows[0]?.name ?? "unknown";
  }

  async byId(id: number): Promise<Order | undefined> {
    const r = await pool.query<Order>("SELECT * FROM orders WHERE id = $1", [
      id,
    ]);
    return r.rows[0];
  }

  /** A deliberately slow report (pg_sleep), highlighted as a slow query. */
  async revenueReport(): Promise<{ status: string; revenue: string }[]> {
    const r = await pool.query<{ status: string; revenue: string }>(
      "SELECT status, sum(total) AS revenue, pg_sleep(0.15) FROM orders GROUP BY status",
    );
    return r.rows.map(({ status, revenue }) => ({ status, revenue }));
  }

  /** Fails: the table does not exist. Shows an error span and an error trace. */
  async archived(): Promise<unknown[]> {
    const r = await pool.query(
      "SELECT * FROM archived_orders WHERE status = 'old'",
    );
    return r.rows;
  }
}
