/**
 * The `service_environments` table (D-101): the (service, environment) pairs seen, with the last
 * time a batch carried them. Written by the span writer (inside its transaction), the log writer
 * and the metric writer, so an environment that only sends logs or metrics is still listed.
 * A pair is refreshed at most once a minute per server process.
 */
import type { Pool, PoolClient } from "pg";

const REFRESH_MS = 60_000;

export type EnvironmentPair = readonly [
  service: string,
  environment: string | null,
];

export class EnvironmentTracker {
  /** `JSON.stringify([service, environment])` → when its row was refreshed. */
  private readonly written = new Map<string, number>();

  /** The pairs of `items` whose row is due, sorted (a stable lock order), without repeats. */
  due(
    items: Iterable<{ service: string; environment: string | null }>,
  ): EnvironmentPair[] {
    const now = Date.now();
    const due = new Map<string, EnvironmentPair>();
    for (const item of items) {
      const pair: EnvironmentPair = [item.service, item.environment];
      const key = JSON.stringify(pair);
      const at = this.written.get(key);
      if (at === undefined || now - at >= REFRESH_MS) due.set(key, pair);
    }
    return [...due.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, pair]) => pair);
  }

  /** Writes the pairs on `db` (a connection inside the caller's transaction, or the pool). */
  async insert(
    db: Pick<Pool | PoolClient, "query">,
    pairs: readonly EnvironmentPair[],
  ): Promise<void> {
    if (pairs.length === 0) return;
    await db.query(
      `INSERT INTO service_environments (service_name, environment, last_seen)
         SELECT u.s, u.e, now() FROM unnest($1::text[], $2::text[]) AS u(s, e)
       ON CONFLICT (service_name, environment) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
    );
  }

  /** Call once the rows are committed. */
  markWritten(pairs: readonly EnvironmentPair[]): void {
    const now = Date.now();
    for (const pair of pairs) this.written.set(JSON.stringify(pair), now);
  }

  /**
   * Refreshes the due pairs outside any transaction, for the log and metric writers. The data is
   * already stored, so a failure here is swallowed (the pair stays due and the next batch retries).
   */
  async touch(
    pool: Pool,
    items: Iterable<{ service: string; environment: string | null }>,
  ): Promise<void> {
    try {
      const pairs = this.due(items);
      if (pairs.length === 0) return;
      await this.insert(pool, pairs);
      this.markWritten(pairs);
    } catch {
      // Statistics of what was seen only; never fails an export.
    }
  }
}
