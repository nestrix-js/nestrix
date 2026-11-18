/**
 * The error-group sync (issue #26, D-103): keeps `error_groups` (stored state, first and last
 * seen, releases) and `error_group_releases` current from the stored spans, and turns a resolved
 * group's next occurrence into a regression.
 *
 * It runs beside ingest, not inside it. A group's identity needs the trace's route and the
 * occurrence rules (D-93: propagation, the legacy parent rule), which are known only once spans
 * are stored, so the ingest path stays as fast as it was and a group shows up in the table within
 * one interval plus `lagMs` (30 s + 15 s by default).
 *
 * - One instance runs at a time (session advisory lock `ERROR_GROUPS_LOCK`); the others skip.
 * - A watermark (`error_group_sync`) marks the spans already counted. Each run reads the
 *   occurrences that started after the watermark minus `overlapMs`, up to `now - lagMs`, in
 *   chunks of an hour (the first run reads 7 days, like the lists' history). A chunk
 *   `(watermark, to]` counts the occurrences whose occurrence time it holds, plus those after
 *   `to` whose span started before the next chunk's read (`to - overlapMs`); the others after
 *   `to` are left to the next chunk, which reads them again (`countedInChunk`). Chunks meet, so
 *   each occurrence is counted once (audit: a span crossing `to` used to count on both runs).
 *   The overlap otherwise only repairs first/last seen and the releases, which are min/max and
 *   so idempotent. Pages: a chunk reads `rowCap` rows at a time, continuing on the total order
 *   `(start_time, trace_id, span_id)` until a short page, so a full page inside the overlap loses
 *   nothing; after `MAX_PAGES_PER_CHUNK` pages it stops at the last row's start (the watermark
 *   there, the rest next run).
 *   Known limit (D-103 (2), D-107 (9)): a span is read only while the watermark has not passed
 *   its start plus `overlapMs` (2 minutes by default, plus the lag). A span stored after that
 *   (a job that ends minutes after it started, a late export, a slow clock) is never read: it has
 *   no group, no `new_error_group` alert and no count, not just a low one. The fix is an
 *   ingest-order column on `spans` (D-107 (9)), which the sync would follow instead of the start
 *   time.
 * - One transaction per chunk: group rows locked, regressions decided, rows upserted, watermark
 *   moved. A crash repeats the chunk and counts nothing twice.
 * - Regression: a `resolved` group with an occurrence after `resolved_at` whose release differs
 *   from `resolved_in_release`, or where either is unknown, becomes `regressed` at that
 *   occurrence's time and its `regressions` counter goes up (the alert episode). The same release
 *   after the resolution does not regress it (the old code is still running). `ignored` and
 *   `regressed` groups keep their state.
 * - Groups are kept: only `open` groups unseen for 90 days are deleted (hourly), so a group
 *   people decided about never expires with the spans it came from.
 * - Groups are per (service, environment, key) (issue #28, D-101): the same error in staging and
 *   production is two stored groups with their own state, releases and alerts. The environment
 *   is the span's, stored as `''` when unset (migration 0018).
 * - Failures are caught and logged; nothing here can throw out of the timer.
 */
import type { Pool } from "pg";
import {
  type ErrorOccurrence,
  groupKeyOf,
  normaliseMessage,
} from "../query/error-groups.js";
import { INSIGHTS_MS } from "../query/error-insights.js";
import type { QueryService } from "../query/query.service.js";
import { ALL } from "../query/scope.js";
import { ADVISORY_CLASS, ERROR_GROUPS_LOCK } from "../storage/locks.js";
import { keyHashOf, storedEnvironment } from "./triage.js";

export interface ErrorSyncOptions {
  /** Default 30 000. */
  intervalMs?: number;
  /** First run after start. Default 5 000. */
  initialDelayMs?: number;
  /** Spans younger than this are left for the next run. Default 15 000. */
  lagMs?: number;
  /** How far before the watermark a run reads again. Default 120 000. */
  overlapMs?: number;
  /** How far back the first run reads. Default 7 days. */
  backfillMs?: number;
  /** Rows read per page; a chunk reads up to ten pages, the rest continue in the next run. Default 20 000. */
  rowCap?: number;
  /** Open groups unseen for this long are deleted. Default 90 days. */
  openRetentionMs?: number;
  /** False: no timer (tests call `runOnce`). Default true. */
  schedule?: boolean;
  now?: () => number;
  onError?: (message: string) => void;
}

export const ERROR_SYNC_OPTIONS = Symbol("nestrix-server:error-sync-options");

export interface SyncRun {
  skipped?: "locked" | "busy";
  /** Occurrences read after the watermark (counted). */
  counted: number;
  groups: number;
  regressed: number;
}

const CHUNK_MS = 3_600_000;
const MAX_CHUNKS = 200;
/** Pages of `rowCap` rows one chunk reads before it stops at the last row's start (no loss). */
const MAX_PAGES_PER_CHUNK = 10;
const PRUNE_EVERY_MS = 3_600_000;
const BATCH = 1000;

interface ReleaseAgg {
  firstMs: number;
  lastMs: number;
  counted: number;
}

interface Agg {
  service: string;
  /** Stored form: `''` is unset. */
  environment: string;
  key: string;
  hash: string;
  errorType: string | undefined;
  pattern: string;
  route: string | undefined;
  firstMs: number;
  lastMs: number;
  firstRelease: string | undefined;
  firstReleaseMs: number;
  lastRelease: string | undefined;
  lastReleaseMs: number;
  counted: number;
  releases: Map<string, ReleaseAgg>;
  /** Every occurrence read, for regression decisions. */
  times: { ms: number; release: string | undefined }[];
}

/**
 * Whether the run over the chunk `(wmMs, toMs]` counts `o` (audit, D-103). Runs read the
 * occurrences whose span started in `[wm - overlap, to]`, and successive chunks meet (the next
 * one starts at `toMs`), so each occurrence is counted by exactly one run that reads it: the one
 * whose chunk holds its occurrence time, or, when its span started before the next run's read
 * (`toMs - overlapMs`), this one, since no later run sees it. An occurrence at or before the
 * watermark is never counted (it arrived after the watermark passed it).
 */
export function countedInChunk(
  o: Pick<ErrorOccurrence, "timeUnixMs" | "startUnixMs">,
  wmMs: number,
  toMs: number,
  overlapMs: number,
): boolean {
  if (o.timeUnixMs <= wmMs) return false;
  if (o.timeUnixMs <= toMs) return true;
  const start = o.startUnixMs ?? o.timeUnixMs;
  return start < toMs - overlapMs;
}

/**
 * Groups occurrences by (service, environment, group key). `counted`: a number counts the ones
 * after it; a function decides per occurrence (the sync passes {@link countedInChunk}).
 */
export function aggregate(
  occurrences: readonly ErrorOccurrence[],
  counted: number | ((o: ErrorOccurrence) => boolean),
): Map<string, Agg> {
  const isCounted =
    typeof counted === "number"
      ? (o: ErrorOccurrence) => o.timeUnixMs > counted
      : counted;
  const out = new Map<string, Agg>();
  for (const o of occurrences) {
    if (o.service === undefined) continue;
    const pattern = o.message === undefined ? "" : normaliseMessage(o.message);
    const key = groupKeyOf(o.errorType, pattern, o.route);
    const environment = storedEnvironment(o.environment);
    const id = `${o.service}\u0000${environment}\u0000${key}`;
    let a = out.get(id);
    if (a === undefined) {
      a = {
        service: o.service,
        environment,
        key,
        hash: keyHashOf(key),
        errorType: o.errorType,
        pattern,
        route: o.route,
        firstMs: o.timeUnixMs,
        lastMs: o.timeUnixMs,
        firstRelease: undefined,
        firstReleaseMs: Number.POSITIVE_INFINITY,
        lastRelease: undefined,
        lastReleaseMs: Number.NEGATIVE_INFINITY,
        counted: 0,
        releases: new Map(),
        times: [],
      };
      out.set(id, a);
    }
    const counts = isCounted(o);
    if (counts) a.counted++;
    if (o.timeUnixMs < a.firstMs) a.firstMs = o.timeUnixMs;
    if (o.timeUnixMs > a.lastMs) a.lastMs = o.timeUnixMs;
    a.times.push({ ms: o.timeUnixMs, release: o.release });
    if (o.release !== undefined) {
      if (o.timeUnixMs < a.firstReleaseMs) {
        a.firstReleaseMs = o.timeUnixMs;
        a.firstRelease = o.release;
      }
      if (o.timeUnixMs >= a.lastReleaseMs) {
        a.lastReleaseMs = o.timeUnixMs;
        a.lastRelease = o.release;
      }
      const r = a.releases.get(o.release);
      if (r === undefined) {
        a.releases.set(o.release, {
          firstMs: o.timeUnixMs,
          lastMs: o.timeUnixMs,
          counted: counts ? 1 : 0,
        });
      } else {
        if (o.timeUnixMs < r.firstMs) r.firstMs = o.timeUnixMs;
        if (o.timeUnixMs > r.lastMs) r.lastMs = o.timeUnixMs;
        if (counts) r.counted++;
      }
    }
  }
  return out;
}

/**
 * The time of the occurrence that regresses a group resolved at `resolvedAtMs` in
 * `resolvedInRelease`: the earliest one after the resolution in another release (or in any, when
 * one of the two releases is unknown). Undefined when none does.
 */
export function regressionTime(
  times: readonly { ms: number; release: string | undefined }[],
  resolvedAtMs: number,
  resolvedInRelease: string | null,
): number | undefined {
  let best: number | undefined;
  for (const t of times) {
    if (t.ms <= resolvedAtMs) continue;
    const same =
      resolvedInRelease !== null &&
      t.release !== undefined &&
      t.release === resolvedInRelease;
    if (same) continue;
    if (best === undefined || t.ms < best) best = t.ms;
  }
  return best;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class ErrorGroupSync {
  private readonly o: Required<
    Omit<ErrorSyncOptions, "schedule" | "now" | "onError">
  >;
  private readonly now: () => number;
  private readonly onError: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<SyncRun> | undefined;
  private lastPruneMs = 0;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly query: Pick<QueryService, "errorOccurrences">,
    options: ErrorSyncOptions = {},
  ) {
    this.o = {
      intervalMs: options.intervalMs ?? 30_000,
      initialDelayMs: options.initialDelayMs ?? 5_000,
      lagMs: options.lagMs ?? 15_000,
      overlapMs: options.overlapMs ?? 120_000,
      backfillMs: options.backfillMs ?? INSIGHTS_MS,
      rowCap: options.rowCap ?? 20_000,
      openRetentionMs: options.openRetentionMs ?? 90 * 86_400_000,
    };
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const tick = () => {
      this.runOnce().catch(() => undefined);
    };
    const first = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, this.o.intervalMs);
      this.timer.unref();
    }, this.o.initialDelayMs);
    first.unref();
    this.timer = first;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running?.catch(() => undefined);
  }

  /** One pass over the spans not yet counted. Never rejects. */
  runOnce(): Promise<SyncRun> {
    if (this.running !== undefined) {
      return Promise.resolve({
        skipped: "busy",
        counted: 0,
        groups: 0,
        regressed: 0,
      });
    }
    const run = this.sync()
      .catch((error) => {
        this.report("error group sync failed", error);
        return { counted: 0, groups: 0, regressed: 0 } as SyncRun;
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = run;
    return run;
  }

  private report(context: string, error: unknown): void {
    try {
      this.onError(`${context}: ${(error as Error)?.message ?? String(error)}`);
    } catch {
      // A failing logger must not break the run.
    }
  }

  private async sync(): Promise<SyncRun> {
    const client = await this.pool.connect();
    let locked = false;
    let broken: Error | undefined;
    const total: SyncRun = { counted: 0, groups: 0, regressed: 0 };
    try {
      const got = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [ADVISORY_CLASS, ERROR_GROUPS_LOCK],
      );
      locked = got.rows[0]?.locked === true;
      if (!locked)
        return { skipped: "locked", counted: 0, groups: 0, regressed: 0 };

      const nowMs = this.now();
      const hiMs = Math.floor(nowMs - this.o.lagMs);
      const mark = await client.query<{ watermark: Date }>(
        "SELECT watermark FROM error_group_sync WHERE id = 1",
      );
      let wm = mark.rows[0]?.watermark.getTime();
      if (wm === undefined) {
        wm = Math.floor(nowMs - this.o.backfillMs);
        await client.query(
          "INSERT INTO error_group_sync (id, watermark) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
          [new Date(wm)],
        );
      }
      for (let i = 0; i < MAX_CHUNKS && wm < hiMs; i++) {
        let to = Math.min(hiMs, wm + CHUNK_MS);
        // Pages of `rowCap` rows, ascending by (start, trace, span); a full page continues from
        // its last row until a short one, so nothing between the pages is skipped, however many
        // rows the overlap `[wm - overlapMs, wm]` alone holds (audit).
        let rows: ErrorOccurrence[] = [];
        let after:
          | { startTime: string; traceId: string; spanId: string }
          | undefined;
        for (let pages = 1; ; pages++) {
          const page: ErrorOccurrence[] = await this.query.errorOccurrences(
            new Date(wm - this.o.overlapMs),
            undefined,
            ALL,
            this.o.rowCap,
            { until: new Date(to + 1), ascending: true, after },
          );
          rows = rows.concat(page);
          const last = page[page.length - 1];
          if (page.length < this.o.rowCap || last === undefined) break;
          // Past the page budget, stop the chunk before the last row's start millisecond and read
          // on from there next time; every row that started by then was read. Only when that
          // moves the watermark: inside the overlap (`cut <= wm`) the run reads on, since the
          // watermark cannot go back.
          if (pages >= MAX_PAGES_PER_CHUNK) {
            const cut = Math.floor(last.startUnixMs ?? last.timeUnixMs) - 1;
            if (cut > wm) {
              to = cut;
              rows = rows.filter((r) => (r.startUnixMs ?? r.timeUnixMs) <= to);
              break;
            }
          }
          if (last.startTime === undefined) break;
          after = {
            startTime: last.startTime,
            traceId: last.traceId,
            spanId: last.spanId,
          };
        }
        const done = await this.apply(client, rows, wm, to);
        total.counted += done.counted;
        total.groups += done.groups;
        total.regressed += done.regressed;
        wm = to;
      }
      await this.prune(client, nowMs);
    } catch (error) {
      broken = error as Error;
      throw error;
    } finally {
      try {
        if (locked && broken === undefined) {
          await client.query("SELECT pg_advisory_unlock($1, $2)", [
            ADVISORY_CLASS,
            ERROR_GROUPS_LOCK,
          ]);
        }
        client.release(broken);
      } catch (error) {
        client.release(error as Error);
      }
    }
    return total;
  }

  private async prune(
    client: import("pg").PoolClient,
    nowMs: number,
  ): Promise<void> {
    if (nowMs - this.lastPruneMs < PRUNE_EVERY_MS) return;
    try {
      await client.query(
        "DELETE FROM error_groups WHERE state = 'open' AND last_seen < $1",
        [new Date(nowMs - this.o.openRetentionMs)],
      );
      this.lastPruneMs = nowMs;
    } catch (error) {
      this.report("error group retention failed", error);
    }
  }

  /** One chunk in one transaction. */
  private async apply(
    client: import("pg").PoolClient,
    rows: readonly ErrorOccurrence[],
    wmMs: number,
    toMs: number,
  ): Promise<{ counted: number; groups: number; regressed: number }> {
    const aggs = [
      ...aggregate(rows, (o) =>
        countedInChunk(o, wmMs, toMs, this.o.overlapMs),
      ).values(),
    ];
    let counted = 0;
    for (const a of aggs) counted += a.counted;
    let regressed = 0;
    await client.query("BEGIN");
    try {
      // Resolved groups seen in this chunk: lock them, decide their regressions.
      const regress: { a: Agg; atMs: number }[] = [];
      for (let i = 0; i < aggs.length; i += BATCH) {
        const part = aggs.slice(i, i + BATCH);
        const res = await client.query<{
          service_name: string;
          environment: string;
          key_hash: string;
          resolved_at: Date | null;
          resolved_in_release: string | null;
        }>(
          `SELECT g.service_name, g.environment, g.key_hash, g.resolved_at, g.resolved_in_release
             FROM error_groups g
             JOIN unnest($1::text[], $2::text[], $3::text[]) AS k(service_name, environment, key_hash)
               ON g.service_name = k.service_name AND g.environment = k.environment
              AND g.key_hash = k.key_hash
            WHERE g.state = 'resolved' FOR UPDATE OF g`,
          [
            part.map((a) => a.service),
            part.map((a) => a.environment),
            part.map((a) => a.hash),
          ],
        );
        for (const r of res.rows) {
          const a = part.find(
            (x) =>
              x.service === r.service_name &&
              x.environment === r.environment &&
              x.hash === r.key_hash,
          );
          if (a === undefined || r.resolved_at === null) continue;
          const at = regressionTime(
            a.times,
            r.resolved_at.getTime(),
            r.resolved_in_release,
          );
          if (at !== undefined) regress.push({ a, atMs: at });
        }
      }
      for (let i = 0; i < aggs.length; i += BATCH) {
        const part = aggs.slice(i, i + BATCH);
        await client.query(
          `INSERT INTO error_groups
             (service_name, key_hash, group_key, error_type, pattern, route,
              first_seen, last_seen, first_release, last_release, occurrences, environment)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                                $6::text[], $7::timestamptz[], $8::timestamptz[], $9::text[],
                                $10::text[], $11::bigint[], $12::text[])
           ON CONFLICT (service_name, environment, key_hash) DO UPDATE SET
             first_release = CASE WHEN EXCLUDED.first_seen < error_groups.first_seen
                                  THEN coalesce(EXCLUDED.first_release, error_groups.first_release)
                                  ELSE coalesce(error_groups.first_release, EXCLUDED.first_release) END,
             last_release = CASE WHEN EXCLUDED.last_seen >= error_groups.last_seen
                                 THEN coalesce(EXCLUDED.last_release, error_groups.last_release)
                                 ELSE coalesce(error_groups.last_release, EXCLUDED.last_release) END,
             first_seen = least(error_groups.first_seen, EXCLUDED.first_seen),
             last_seen = greatest(error_groups.last_seen, EXCLUDED.last_seen),
             occurrences = error_groups.occurrences + EXCLUDED.occurrences`,
          [
            part.map((a) => a.service),
            part.map((a) => a.hash),
            part.map((a) => a.key),
            part.map((a) => a.errorType ?? null),
            part.map((a) => a.pattern),
            part.map((a) => a.route ?? null),
            part.map((a) => iso(a.firstMs)),
            part.map((a) => iso(a.lastMs)),
            part.map((a) => a.firstRelease ?? null),
            part.map((a) => a.lastRelease ?? null),
            part.map((a) => a.counted),
            part.map((a) => a.environment),
          ],
        );
      }
      const perRelease = aggs.flatMap((a) =>
        [...a.releases].map(([release, r]) => ({ a, release, r })),
      );
      for (let i = 0; i < perRelease.length; i += BATCH) {
        const part = perRelease.slice(i, i + BATCH);
        await client.query(
          `INSERT INTO error_group_releases
             (service_name, key_hash, release, first_seen, last_seen, occurrences, environment)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[],
                                $5::timestamptz[], $6::bigint[], $7::text[])
           ON CONFLICT (service_name, environment, key_hash, release) DO UPDATE SET
             first_seen = least(error_group_releases.first_seen, EXCLUDED.first_seen),
             last_seen = greatest(error_group_releases.last_seen, EXCLUDED.last_seen),
             occurrences = error_group_releases.occurrences + EXCLUDED.occurrences`,
          [
            part.map((p) => p.a.service),
            part.map((p) => p.a.hash),
            part.map((p) => p.release),
            part.map((p) => iso(p.r.firstMs)),
            part.map((p) => iso(p.r.lastMs)),
            part.map((p) => p.r.counted),
            part.map((p) => p.a.environment),
          ],
        );
      }
      for (const { a, atMs } of regress) {
        const res = await client.query(
          `UPDATE error_groups
              SET state = 'regressed', regressed_at = $3, regressed_detected_at = now(),
                  regressions = regressions + 1
            WHERE service_name = $1 AND key_hash = $2 AND environment = $4
              AND state = 'resolved'`,
          [a.service, a.hash, new Date(atMs), a.environment],
        );
        regressed += res.rowCount ?? 0;
      }
      await client.query(
        "UPDATE error_group_sync SET watermark = $1 WHERE id = 1",
        [new Date(toMs)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    return { counted, groups: aggs.length, regressed };
  }
}
