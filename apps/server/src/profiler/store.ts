/**
 * Storage and state machine of remote CPU profiling (docs/backlog/phase-10.md P10-02, D-76):
 * tables `instances` and `remote_profiles` (migration `0008_remote_profiles.sql`).
 *
 * States: `pending` (an admin asked) → `running` (handed to the instance on its check-in) →
 * `done` (uploaded) | `failed` (the instance reported a failure) | `expired` (pending over
 * 60 s, or running over duration + 60 s). Every timestamp is the database's `now()`, so several
 * server instances agree. Expiry runs before every read and transition, and on a timer with the
 * retention (the newest 20 finished per service, nothing older than the span retention, instances
 * not seen for a day).
 *
 * Ownership: a capture is handed only to a check-in for its `service` + `instanceId`, made with the
 * ingest key that owns that instance (the key of its first check-in); the key that received the
 * order is recorded as the capture's `principal`, and only that key may upload it or report its
 * failure. The principal is a fingerprint of the key (first 16 hex characters of its SHA-256), so
 * rotating or reordering `NESTRIX_INGEST_KEYS` keeps every key's instances; an old `key:<index>`
 * principal is replaced by the fingerprint at the next check-in. With ingest auth off every request
 * has the principal `none` (anyone can send anyway).
 *
 * Runtime figures (P15-03, D-80, migration `0011_instance_runtime.sql`): each check-in's validated
 * `runtimeSample` is written by the same upsert, NULL when absent, so `instances` always shows the
 * latest check-in's figures or none. Their time is the server's `now()` of that check-in.
 */
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type {
  CaptureOrder,
  FlameNode,
  InstanceRuntimeSample,
  InstanceSummary,
  ProfileFunction,
  RemoteProfileState,
  RemoteProfileSummary,
} from "@nestrix-js/protocol";
import type { Pool, PoolClient } from "pg";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { normalizeProfile } from "./normalize.js";

const gunzip = promisify(gunzipCallback);

/** An instance counts as live while its last check-in is this recent. */
export const INSTANCE_WINDOW_MS = 120_000;
/** A pending capture not picked up within this long expires. */
export const PENDING_TIMEOUT_MS = 60_000;
/** A running capture expires this long after its requested duration without an upload. */
export const UPLOAD_GRACE_MS = 60_000;
/** A new capture for an instance waits this long after its previous one finished. */
export const COOLDOWN_MS = 10_000;
/** Finished captures kept per service. */
export const KEPT_PER_SERVICE = 20;
/** Instances not seen for this long are deleted. */
export const INSTANCE_RETENTION_MS = 86_400_000;
/** What the check-in answers as `nextCheckInMs`. */
export const CHECK_IN_INTERVAL_MS = 15_000;
/** Rows `list` returns. */
export const MAX_LISTED_PROFILES = 50;
/** Rows `instances` returns. */
export const MAX_LISTED_INSTANCES = 500;
/** Interval of the expiry and retention sweep. */
export const SWEEP_INTERVAL_MS = 60_000;
/** Summaries (top functions, flame) kept in memory. */
const SUMMARY_CACHE_SIZE = 8;

export const PENDING_EXPIRED_MESSAGE =
  "The instance did not check in within 60 s of the request.";
/** A `running` capture older than this, which its instance does not report, was never received. */
export const ORDER_LOST_AFTER_MS = 20_000;
export const ORDER_LOST_MESSAGE = "the instance did not receive the order";
export const RUNNING_EXPIRED_MESSAGE =
  "The instance did not upload the profile within its duration plus 60 s.";

/** The validated figures of a check-in's `runtimeSample`; at least one is not null. */
export interface CheckInRuntime {
  cpuPercent: number | null;
  eventLoopP99Ms: number | null;
  heapUsedBytes: number | null;
  rssBytes: number | null;
}

/** The validated fields of a check-in. */
export interface CheckIn {
  service: string;
  instanceId: string;
  version: string | null;
  host: string | null;
  pid: number | null;
  runtime: string | null;
  sdkVersion: string | null;
  /** The capture the instance says it runs now (`runningCaptureId`). */
  runningCaptureId: string | null;
  /** `null` when the check-in carried no usable sample. */
  runtimeSample: CheckInRuntime | null;
}

/** What `complete` stores. */
export interface CompletedProfile {
  /** The normalised `.cpuprofile`, gzipped. */
  gzipped: Buffer;
  /** Bytes of the `.cpuprofile` before gzip (the download's size). */
  bytes: number;
  samples: number;
  actualDurationMs: number;
}

export type CheckInResult =
  | { kind: "ok"; capture?: CaptureOrder }
  /** The instance belongs to another ingest key. */
  | { kind: "conflict" };

export type StartResult =
  | { kind: "started"; capture: RemoteProfileSummary }
  | { kind: "not_found" }
  | { kind: "conflict"; capture: RemoteProfileSummary }
  | { kind: "cooldown"; retryAfterSeconds: number };

/** `not_found` also covers a capture owned by another ingest key, so ids are not confirmed to it. */
export type OwnedResult = "ok" | "not_found" | "wrong_state";

interface ProfileRow {
  id: string;
  service: string;
  instance_id: string;
  version: string | null;
  state: RemoteProfileState;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number;
  actual_duration_ms: number | null;
  samples: number | null;
  bytes: number | null;
  error: string | null;
}

const PROFILE_COLUMNS =
  "id, service, instance_id, version, state, requested_at, started_at, finished_at, duration_ms, actual_duration_ms, samples, bytes, error";

function toSummary(row: ProfileRow): RemoteProfileSummary {
  return {
    id: row.id,
    service: row.service,
    instanceId: row.instance_id,
    version: row.version,
    state: row.state,
    requestedAtUnixMs: row.requested_at.getTime(),
    startedAtUnixMs: row.started_at?.getTime() ?? null,
    finishedAtUnixMs: row.finished_at?.getTime() ?? null,
    durationMs: Number(row.duration_ms),
    actualDurationMs:
      row.actual_duration_ms === null ? null : Number(row.actual_duration_ms),
    samples: row.samples === null ? null : Number(row.samples),
    bytes: row.bytes === null ? null : Number(row.bytes),
    error: row.error,
  };
}

/** The stored figures as `InstanceSummary.runtimeSample`: absent figures left out. */
function toRuntimeSample(row: {
  cpu_percent: number | null;
  event_loop_p99_ms: number | null;
  heap_used_bytes: number | null;
  rss_bytes: number | null;
  runtime_sampled_at: Date | null;
}): InstanceRuntimeSample | null {
  if (row.runtime_sampled_at === null) return null;
  const sample: InstanceRuntimeSample = {
    sampledAtUnixMs: row.runtime_sampled_at.getTime(),
  };
  if (row.cpu_percent !== null) sample.cpuPercent = Number(row.cpu_percent);
  if (row.event_loop_p99_ms !== null) {
    sample.eventLoopP99Ms = Number(row.event_loop_p99_ms);
  }
  if (row.heap_used_bytes !== null) {
    sample.heapUsedBytes = Number(row.heap_used_bytes);
  }
  if (row.rss_bytes !== null) sample.rssBytes = Number(row.rss_bytes);
  return sample;
}

/** A random capture id: 16 lowercase hex characters. */
export function newCaptureId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * The conditions under which an active capture has expired, for `UPDATE … WHERE`. Uses only
 * constants, never input.
 */
const EXPIRED_WHERE = `(state = 'pending' AND requested_at < now() - interval '${PENDING_TIMEOUT_MS} milliseconds')
   OR (state = 'running' AND started_at < now() - (duration_ms + ${UPLOAD_GRACE_MS}) * interval '1 millisecond')`;

@Injectable()
export class RemoteProfileStore
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger("NestrixRemoteProfiles");
  private timer: NodeJS.Timeout | undefined;
  private lastErrorLogMs = Number.NEGATIVE_INFINITY;
  private readonly summaries = new Map<
    string,
    { topFunctions: ProfileFunction[]; flame: FlameNode }
  >();
  /** Whether the periodic sweep runs (tests turn it off to drive `sweep` themselves). */
  sweepEnabled = true;

  constructor(
    @Inject(STORAGE_POOL) private readonly pool: Pool,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => this.logFailure("sweep failed", error));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The ownership principal of an ingest principal: `none` with ingest auth off. */
  owner(principal: string): string {
    return this.config.ingest.auth === "none" ? "none" : principal;
  }

  /** Expires pending and running captures past their time. */
  async expire(db: Pool | PoolClient = this.pool): Promise<void> {
    await db.query(
      `UPDATE remote_profiles
          SET state = 'expired', finished_at = now(),
              error = CASE WHEN state = 'pending' THEN $1 ELSE $2 END
        WHERE ${EXPIRED_WHERE}`,
      [PENDING_EXPIRED_MESSAGE, RUNNING_EXPIRED_MESSAGE],
    );
  }

  /** Expiry plus retention. */
  async sweep(): Promise<void> {
    await this.expire();
    // The newest KEPT_PER_SERVICE finished captures per service; active ones are never removed.
    await this.pool.query(
      `DELETE FROM remote_profiles r
        USING (SELECT id, row_number() OVER (PARTITION BY service ORDER BY requested_at DESC) AS n
                 FROM remote_profiles WHERE state NOT IN ('pending', 'running')) ranked
        WHERE r.id = ranked.id AND ranked.n > $1`,
      [KEPT_PER_SERVICE],
    );
    // The span retention: today (UTC) and `retentionDays` days before it (storage/partitions.ts).
    await this.pool.query(
      `DELETE FROM remote_profiles
        WHERE state NOT IN ('pending', 'running')
          AND requested_at < date_trunc('day', now(), 'UTC') - make_interval(days => $1)`,
      [this.config.retentionDays],
    );
    await this.pool.query(
      `DELETE FROM instances WHERE last_seen < now() - interval '${INSTANCE_RETENTION_MS} milliseconds'`,
    );
  }

  /**
   * Records a check-in and hands over the instance's pending capture, if any. Refused
   * (`conflict`) when the instance id was registered by another ingest key.
   */
  async checkIn(checkIn: CheckIn, principal: string): Promise<CheckInResult> {
    const owner = this.owner(principal);
    return this.transaction(async (client) => {
      const upsert = await client.query(
        `INSERT INTO instances (service, instance_id, version, host, pid, runtime, sdk_version, principal,
                                cpu_percent, event_loop_p99_ms, heap_used_bytes, rss_bytes,
                                runtime_sampled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 CASE WHEN $13::boolean THEN now() END)
         ON CONFLICT (service, instance_id) DO UPDATE
            SET version = EXCLUDED.version, host = EXCLUDED.host, pid = EXCLUDED.pid,
                runtime = EXCLUDED.runtime, sdk_version = EXCLUDED.sdk_version, last_seen = now(),
                principal = EXCLUDED.principal,
                cpu_percent = EXCLUDED.cpu_percent, event_loop_p99_ms = EXCLUDED.event_loop_p99_ms,
                heap_used_bytes = EXCLUDED.heap_used_bytes, rss_bytes = EXCLUDED.rss_bytes,
                runtime_sampled_at = EXCLUDED.runtime_sampled_at
          WHERE instances.principal = EXCLUDED.principal
             OR instances.principal LIKE 'key:%'
         RETURNING 1`,
        [
          checkIn.service,
          checkIn.instanceId,
          checkIn.version,
          checkIn.host,
          checkIn.pid,
          checkIn.runtime,
          checkIn.sdkVersion,
          owner,
          checkIn.runtimeSample?.cpuPercent ?? null,
          checkIn.runtimeSample?.eventLoopP99Ms ?? null,
          checkIn.runtimeSample?.heapUsedBytes ?? null,
          checkIn.runtimeSample?.rssBytes ?? null,
          checkIn.runtimeSample !== null,
        ],
      );
      if (upsert.rowCount === 0) return { kind: "conflict" };
      // Rows from before ownership followed the key's fingerprint carry `key:<index>`; the check-in
      // that just claimed the instance carries the same claim over to its running capture.
      await client.query(
        `UPDATE remote_profiles SET principal = $3
          WHERE service = $1 AND instance_id = $2 AND state = 'running' AND principal LIKE 'key:%'`,
        [checkIn.service, checkIn.instanceId, owner],
      );
      // An order handed over but never received (the answer was lost): the instance does not
      // report it as running. Fail it, so a new one can be handed out and started.
      await client.query(
        `UPDATE remote_profiles SET state = 'failed', finished_at = now(), error = $3
          WHERE service = $1 AND instance_id = $2 AND state = 'running'
            AND started_at < now() - interval '${ORDER_LOST_AFTER_MS} milliseconds'
            AND ($4::text IS NULL OR id <> $4::text)`,
        [
          checkIn.service,
          checkIn.instanceId,
          ORDER_LOST_MESSAGE,
          checkIn.runningCaptureId,
        ],
      );
      const handed = await client.query<{ id: string; duration_ms: number }>(
        `UPDATE remote_profiles SET state = 'running', started_at = now(), principal = $3
          WHERE id = (SELECT id FROM remote_profiles
                       WHERE service = $1 AND instance_id = $2 AND state = 'pending'
                         AND requested_at >= now() - interval '${PENDING_TIMEOUT_MS} milliseconds'
                       ORDER BY requested_at LIMIT 1
                       FOR UPDATE SKIP LOCKED)
          RETURNING id, duration_ms`,
        [checkIn.service, checkIn.instanceId, owner],
      );
      const row = handed.rows[0];
      return row === undefined
        ? { kind: "ok" }
        : {
            kind: "ok",
            capture: { id: row.id, durationMs: Number(row.duration_ms) },
          };
    });
  }

  /**
   * Starts a capture for a live instance (`pending`). `not_found` when the instance is unknown or
   * has not checked in for 2 minutes; `conflict` while one is pending or running for it;
   * `cooldown` within 10 s of its previous capture finishing.
   */
  async start(
    service: string,
    instanceId: string,
    durationMs: number,
    requestedBy: string,
  ): Promise<StartResult> {
    return this.transaction(async (client) => {
      // Locks the instance row: concurrent starts for one instance run one after the other.
      const instance = await client.query<{ version: string | null }>(
        `SELECT version FROM instances
          WHERE service = $1 AND instance_id = $2
            AND last_seen >= now() - interval '${INSTANCE_WINDOW_MS} milliseconds'
          FOR UPDATE`,
        [service, instanceId],
      );
      const found = instance.rows[0];
      if (found === undefined) return { kind: "not_found" };
      await this.expire(client);
      const active = await this.activeCapture(client, service, instanceId);
      if (active !== undefined) return { kind: "conflict", capture: active };
      const recent = await client.query<{ wait_ms: string | number }>(
        `SELECT max(extract(epoch FROM (finished_at + interval '${COOLDOWN_MS} milliseconds' - now())) * 1000) AS wait_ms
           FROM remote_profiles
          WHERE service = $1 AND instance_id = $2 AND state IN ('done', 'failed')
            AND finished_at > now() - interval '${COOLDOWN_MS} milliseconds'`,
        [service, instanceId],
      );
      const waitMs = recent.rows[0]?.wait_ms;
      if (waitMs !== null && waitMs !== undefined && Number(waitMs) > 0) {
        return {
          kind: "cooldown",
          retryAfterSeconds: Math.max(1, Math.ceil(Number(waitMs) / 1000)),
        };
      }
      const inserted = await client.query<ProfileRow>(
        `INSERT INTO remote_profiles (id, service, instance_id, version, state, duration_ms, requested_by)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING ${PROFILE_COLUMNS}`,
        [
          newCaptureId(),
          service,
          instanceId,
          found.version,
          durationMs,
          requestedBy,
        ],
      );
      return {
        kind: "started",
        capture: toSummary(inserted.rows[0] as ProfileRow),
      };
    });
  }

  private async activeCapture(
    db: Pool | PoolClient,
    service: string,
    instanceId: string,
  ): Promise<RemoteProfileSummary | undefined> {
    const { rows } = await db.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM remote_profiles
        WHERE service = $1 AND instance_id = $2 AND state IN ('pending', 'running')`,
      [service, instanceId],
    );
    return rows[0] === undefined ? undefined : toSummary(rows[0]);
  }

  /** Whether `principal` may upload `id` now: it received the order and it is still running. */
  async checkOwned(id: string, principal: string): Promise<OwnedResult> {
    await this.expire();
    return this.ownership(this.pool, id, principal);
  }

  private async ownership(
    db: Pool | PoolClient,
    id: string,
    principal: string,
  ): Promise<OwnedResult> {
    const { rows } = await db.query<{
      state: string;
      principal: string | null;
    }>("SELECT state, principal FROM remote_profiles WHERE id = $1", [id]);
    const row = rows[0];
    if (row === undefined) return "not_found";
    if (row.state === "pending") {
      // Not handed to anyone yet: nobody owns it.
      return "not_found";
    }
    if (row.principal !== this.owner(principal)) return "not_found";
    return row.state === "running" ? "ok" : "wrong_state";
  }

  /** Stores an uploaded profile and marks the capture `done`. */
  async complete(
    id: string,
    principal: string,
    profile: CompletedProfile,
  ): Promise<OwnedResult> {
    await this.expire();
    const { rowCount } = await this.pool.query(
      `UPDATE remote_profiles
          SET state = 'done', finished_at = now(), profile = $3, bytes = $4, samples = $5,
              actual_duration_ms = $6, error = NULL
        WHERE id = $1 AND principal = $2 AND state = 'running'`,
      [
        id,
        this.owner(principal),
        profile.gzipped,
        profile.bytes,
        profile.samples,
        profile.actualDurationMs,
      ],
    );
    if ((rowCount ?? 0) > 0) return "ok";
    const owned = await this.ownership(this.pool, id, principal);
    return owned === "ok" ? "wrong_state" : owned;
  }

  /** Marks the capture `failed` with the instance's reason. */
  async fail(
    id: string,
    principal: string,
    message: string,
  ): Promise<OwnedResult> {
    await this.expire();
    const { rowCount } = await this.pool.query(
      `UPDATE remote_profiles SET state = 'failed', finished_at = now(), error = $3
        WHERE id = $1 AND principal = $2 AND state = 'running'`,
      [id, this.owner(principal), message],
    );
    if ((rowCount ?? 0) > 0) return "ok";
    const owned = await this.ownership(this.pool, id, principal);
    return owned === "ok" ? "wrong_state" : owned;
  }

  /** Instances seen in the last 2 minutes, newest check-in first, each with its active capture. */
  async instances(service: string | undefined): Promise<InstanceSummary[]> {
    await this.expire();
    const params: unknown[] = [MAX_LISTED_INSTANCES];
    let where = `i.last_seen >= now() - interval '${INSTANCE_WINDOW_MS} milliseconds'`;
    if (service !== undefined) {
      params.push(service);
      where += " AND i.service = $2";
    }
    const { rows } = await this.pool.query<
      {
        i_service: string;
        i_instance_id: string;
        i_version: string | null;
        host: string | null;
        pid: number | null;
        runtime: string | null;
        sdk_version: string | null;
        first_seen: Date;
        last_seen: Date;
        cpu_percent: number | null;
        event_loop_p99_ms: number | null;
        heap_used_bytes: number | null;
        rss_bytes: number | null;
        runtime_sampled_at: Date | null;
      } & { [K in keyof ProfileRow as `r_${K}`]: ProfileRow[K] | null }
    >(
      `SELECT i.service AS i_service, i.instance_id AS i_instance_id, i.version AS i_version,
              i.host, i.pid, i.runtime, i.sdk_version, i.first_seen, i.last_seen,
              i.cpu_percent, i.event_loop_p99_ms, i.heap_used_bytes, i.rss_bytes,
              i.runtime_sampled_at,
              r.id AS r_id, r.service AS r_service, r.instance_id AS r_instance_id,
              r.version AS r_version, r.state AS r_state, r.requested_at AS r_requested_at,
              r.started_at AS r_started_at, r.finished_at AS r_finished_at,
              r.duration_ms AS r_duration_ms, r.actual_duration_ms AS r_actual_duration_ms,
              r.samples AS r_samples, r.bytes AS r_bytes, r.error AS r_error
         FROM instances i
         LEFT JOIN remote_profiles r
           ON r.service = i.service AND r.instance_id = i.instance_id
          AND r.state IN ('pending', 'running')
        WHERE ${where}
        ORDER BY i.last_seen DESC, i.service, i.instance_id
        LIMIT $1`,
      params,
    );
    return rows.map((row) => ({
      service: row.i_service,
      instanceId: row.i_instance_id,
      version: row.i_version,
      host: row.host,
      pid: row.pid === null ? null : Number(row.pid),
      runtime: row.runtime,
      sdkVersion: row.sdk_version,
      firstSeenUnixMs: row.first_seen.getTime(),
      lastSeenUnixMs: row.last_seen.getTime(),
      runtimeSample: toRuntimeSample(row),
      capture:
        row.r_id === null
          ? null
          : toSummary({
              id: row.r_id,
              service: row.r_service as string,
              instance_id: row.r_instance_id as string,
              version: row.r_version,
              state: row.r_state as RemoteProfileState,
              requested_at: row.r_requested_at as Date,
              started_at: row.r_started_at,
              finished_at: row.r_finished_at,
              duration_ms: row.r_duration_ms as number,
              actual_duration_ms: row.r_actual_duration_ms,
              samples: row.r_samples,
              bytes: row.r_bytes,
              error: row.r_error,
            }),
    }));
  }

  /** Captures, newest first, at most 50. */
  async list(
    service: string | undefined,
    instanceId: string | undefined,
  ): Promise<RemoteProfileSummary[]> {
    await this.expire();
    const params: unknown[] = [MAX_LISTED_PROFILES];
    const where: string[] = [];
    if (service !== undefined) {
      params.push(service);
      where.push(`service = $${params.length}`);
    }
    if (instanceId !== undefined) {
      params.push(instanceId);
      where.push(`instance_id = $${params.length}`);
    }
    const { rows } = await this.pool.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM remote_profiles
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY requested_at DESC, id
        LIMIT $1`,
      params,
    );
    return rows.map(toSummary);
  }

  /** One capture, or `undefined`. */
  async get(id: string): Promise<RemoteProfileSummary | undefined> {
    await this.expire();
    const { rows } = await this.pool.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM remote_profiles WHERE id = $1`,
      [id],
    );
    return rows[0] === undefined ? undefined : toSummary(rows[0]);
  }

  /** The stored `.cpuprofile` of a `done` capture, decompressed, or `undefined`. */
  async profileJson(
    id: string,
  ): Promise<{ summary: RemoteProfileSummary; json: Buffer } | undefined> {
    const { rows } = await this.pool.query<
      ProfileRow & { profile: Buffer | null }
    >(
      `SELECT ${PROFILE_COLUMNS}, profile FROM remote_profiles WHERE id = $1 AND state = 'done'`,
      [id],
    );
    const row = rows[0];
    if (row === undefined || row.profile === null) return undefined;
    return { summary: toSummary(row), json: await gunzip(row.profile) };
  }

  /**
   * Top functions and flame of a `done` capture, computed from the stored profile with the
   * embedded profiler's code and kept for the last few captures (a done profile never changes).
   */
  async summaryOf(
    id: string,
  ): Promise<
    { topFunctions: ProfileFunction[]; flame: FlameNode } | undefined
  > {
    const cached = this.summaries.get(id);
    if (cached !== undefined) {
      this.summaries.delete(id);
      this.summaries.set(id, cached);
      return cached;
    }
    const stored = await this.profileJson(id);
    if (stored === undefined) return undefined;
    const normalized = normalizeProfile(stored.json.toString("utf8"));
    const summary = {
      topFunctions: normalized.topFunctions,
      flame: normalized.flame,
    };
    this.summaries.set(id, summary);
    while (this.summaries.size > SUMMARY_CACHE_SIZE) {
      const oldest = this.summaries.keys().next().value;
      if (oldest === undefined) break;
      this.summaries.delete(oldest);
    }
    return summary;
  }

  private async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch((rollback: Error) => {
        broken = rollback;
      });
      throw error;
    } finally {
      // A connection whose rollback failed is discarded rather than returned to the pool.
      client.release(broken);
    }
  }

  private logFailure(message: string, error: unknown): void {
    try {
      const now = performance.now();
      if (now - this.lastErrorLogMs < 60_000) return;
      this.lastErrorLogMs = now;
      this.logger.warn(
        `${message}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Logging must not fail anything.
    }
  }
}
