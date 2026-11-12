/**
 * Day partitions of the time-ordered tables, and retention.
 *
 * Each of {@link PARTITIONED_TABLES} has one partition per UTC day, named `<table>_pYYYYMMDD`,
 * holding `[day 00:00Z, next day 00:00Z)`. At start and then every hour (`PartitionManager`):
 * partitions for today and the next two days are created, and partitions of days older than the
 * retention are dropped. A day within retention that has no partition (the server was down that
 * day) is created on demand when a span for it arrives (`ensureDays`).
 *
 * Retention keeps today and the `retentionDays` days before it: with 7, on 2026-11-11 the oldest
 * kept day is 2026-11-04, and 2026-11-03 is dropped. So at least `retentionDays * 24` hours and at
 * most one more day are kept. The writer drops spans older than the oldest kept day, and spans
 * starting more than two days ahead (clock skew), counting them (`WriterStats.outOfRange`).
 *
 * DDL runs under a session advisory lock (one instance at a time) with a `lock_timeout`, so a
 * long-running query holding the parent table delays maintenance rather than blocking ingest
 * behind a queued exclusive lock; a timed-out step is retried at the next run.
 */
import type { Pool, PoolClient } from "pg";
import { ADVISORY_CLASS, MAINTENANCE_LOCK } from "./locks.js";

export const PARTITIONED_TABLES = [
  "spans",
  "traces",
  "route_minutes",
  "class_minutes",
  "logs",
] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

const DAY_MS = 86_400_000;
/** Days ahead of today that get partitions, today excluded. */
export const DAYS_AHEAD = 2;
const PARTITION_NAME =
  /^(spans|traces|route_minutes|class_minutes|logs)_p(\d{8})$/;

/** Days since the Unix epoch (UTC) of a Unix-ms time. */
export function utcDay(unixMs: number): number {
  return Math.floor(unixMs / DAY_MS);
}

/** `YYYYMMDD` of a day number. */
export function dayLabel(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10).replaceAll("-", "");
}

function dayBound(day: number): string {
  return `${new Date(day * DAY_MS).toISOString().slice(0, 10)} 00:00:00+00`;
}

function parseLabel(label: string): number | undefined {
  const ms = Date.UTC(
    Number(label.slice(0, 4)),
    Number(label.slice(4, 6)) - 1,
    Number(label.slice(6, 8)),
  );
  return Number.isFinite(ms) ? utcDay(ms) : undefined;
}

export function partitionName(table: PartitionedTable, day: number): string {
  return `${table}_p${dayLabel(day)}`;
}

/** The oldest day kept by retention, for a given today. */
export function oldestKeptDay(today: number, retentionDays: number): number {
  return today - retentionDays;
}

/** Existing partitions of our tables, by table, as day numbers. */
export async function listPartitions(
  db: Pool | PoolClient,
): Promise<Map<PartitionedTable, Set<number>>> {
  const { rows } = await db.query<{ child: string }>(
    `SELECT c.relname AS child
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = current_schema() AND p.relname = ANY($1)`,
    [PARTITIONED_TABLES],
  );
  const out = new Map<PartitionedTable, Set<number>>(
    PARTITIONED_TABLES.map((t) => [t, new Set<number>()]),
  );
  for (const { child } of rows) {
    const m = PARTITION_NAME.exec(child);
    if (!m) continue;
    const day = parseLabel(m[2] as string);
    if (day !== undefined) out.get(m[1] as PartitionedTable)?.add(day);
  }
  return out;
}

async function withMaintenanceLock<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      ADVISORY_CLASS,
      MAINTENANCE_LOCK,
    ]);
    locked = true;
    await client.query("SET lock_timeout = '5s'");
    return await fn(client);
  } finally {
    try {
      await client.query("RESET lock_timeout");
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [
          ADVISORY_CLASS,
          MAINTENANCE_LOCK,
        ]);
      }
      client.release();
    } catch (error) {
      // A broken connection is discarded rather than returned to the pool.
      client.release(error as Error);
    }
  }
}

/** Creates the missing partitions of every table for the given days. Returns the names created. */
export async function ensurePartitions(
  pool: Pool,
  days: Iterable<number>,
): Promise<string[]> {
  const wanted = [...new Set(days)].sort((a, b) => a - b);
  if (wanted.length === 0) return [];
  return withMaintenanceLock(pool, async (client) => {
    const existing = await listPartitions(client);
    const created: string[] = [];
    for (const table of PARTITIONED_TABLES) {
      for (const day of wanted) {
        if (existing.get(table)?.has(day)) continue;
        const name = partitionName(table, day);
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${table}
             FOR VALUES FROM ('${dayBound(day)}') TO ('${dayBound(day + 1)}')`,
        );
        created.push(name);
      }
    }
    return created;
  });
}

/** Drops every partition of a day older than the oldest kept day. Returns the names dropped. */
export async function dropExpiredPartitions(
  pool: Pool,
  retentionDays: number,
  nowUnixMs: number = Date.now(),
): Promise<string[]> {
  const oldest = oldestKeptDay(utcDay(nowUnixMs), retentionDays);
  return withMaintenanceLock(pool, async (client) => {
    const existing = await listPartitions(client);
    const dropped: string[] = [];
    for (const table of PARTITIONED_TABLES) {
      for (const day of [...(existing.get(table) ?? [])].sort(
        (a, b) => a - b,
      )) {
        if (day >= oldest) continue;
        const name = partitionName(table, day);
        await client.query(`DROP TABLE IF EXISTS ${name}`);
        dropped.push(name);
      }
    }
    return dropped;
  });
}

export interface PartitionManagerOptions {
  retentionDays: number;
  /** Interval of the maintenance run; default one hour. */
  intervalMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Where a failed maintenance run is reported; it is retried at the next interval. */
  onError?: (error: unknown) => void;
  onRun?: (result: { created: string[]; dropped: string[] }) => void;
}

/**
 * Runs maintenance at start and on an interval, and knows which days can take rows (a partition
 * exists in every table). The interval timer is unref'ed and every run catches its errors.
 */
export class PartitionManager {
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private available = new Set<number>();
  private running: Promise<void> | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly options: PartitionManagerOptions,
  ) {
    this.retentionDays = options.retentionDays;
    this.intervalMs = options.intervalMs ?? 3_600_000;
    this.now = options.now ?? Date.now;
  }

  /** First run (errors propagate: the server should not start without partitions), then the timer. */
  async start(): Promise<void> {
    await this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => this.options.onError?.(error));
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  today(): number {
    return utcDay(this.now());
  }

  /** The range of days the writer accepts: `[oldest kept day, today + DAYS_AHEAD]`. */
  acceptedDays(): { first: number; last: number } {
    const today = this.today();
    return {
      first: oldestKeptDay(today, this.retentionDays),
      last: today + DAYS_AHEAD,
    };
  }

  hasDay(day: number): boolean {
    return this.available.has(day);
  }

  /** Creates partitions for days in the accepted range that lack one. */
  async ensureDays(days: Iterable<number>): Promise<void> {
    const { first, last } = this.acceptedDays();
    const missing = [...days].filter(
      (d) => d >= first && d <= last && !this.available.has(d),
    );
    if (missing.length === 0) return;
    await ensurePartitions(this.pool, missing);
    await this.refresh();
  }

  /** One maintenance run: create today + DAYS_AHEAD, drop expired, refresh. Runs are not overlapped. */
  runOnce(): Promise<void> {
    this.running ??= (async () => {
      try {
        const today = this.today();
        const created = await ensurePartitions(
          this.pool,
          Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => today + i),
        );
        const dropped = await dropExpiredPartitions(
          this.pool,
          this.retentionDays,
          this.now(),
        );
        await this.refresh();
        this.options.onRun?.({ created, dropped });
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async refresh(): Promise<void> {
    const existing = await listPartitions(this.pool);
    const sets = PARTITIONED_TABLES.map(
      (t) => existing.get(t) ?? new Set<number>(),
    );
    const [first, ...rest] = sets;
    const available = new Set<number>();
    for (const day of first ?? []) {
      if (rest.every((s) => s.has(day))) available.add(day);
    }
    this.available = available;
  }
}
