/**
 * The audit log (issue #34, D-104; table `audit_log`, migration 0019): who signed in or out, who
 * failed to sign in and why, and who changed an alert rule, an SLO or an API token or started a
 * remote CPU capture. Read by admins at `GET /api/v1/audit` and on the Settings page.
 *
 * `AuditLog.record` never rejects and never throws: an entry that cannot be written is logged
 * (at most once a minute) and dropped; the action it describes has already happened, and refusing
 * its answer would not undo it. Rows older than `NESTRIX_RETENTION_DAYS` are deleted at most once
 * an hour per instance, after a write.
 */
import { Logger } from "@nestjs/common";
import type { AuditAction, AuditEntry } from "@nestrix-js/protocol";
import type { Pool } from "pg";

export type AuditActor =
  | { readonly kind: "password" }
  | { readonly kind: "oidc"; readonly userId: number; readonly label: string }
  | { readonly kind: "anonymous"; readonly label?: string };

export interface AuditRecord {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly outcome: "ok" | "failed";
  readonly target?: string | undefined;
  readonly detail?: string | undefined;
  readonly clientAddress?: string | undefined;
}

export const BREAK_GLASS_LABEL = "break-glass admin";

export interface AuditStore {
  insert(record: AuditRecord): Promise<void>;
  /** Newest first, `id < before` when given. */
  list(limit: number, before?: string): Promise<AuditEntry[]>;
  prune(retentionDays: number): Promise<void>;
}

function clip(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stored text is shown in the dashboard
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return clean === "" ? null : clean.slice(0, max);
}

function labelOf(actor: AuditActor): string {
  if (actor.kind === "password") return BREAK_GLASS_LABEL;
  if (actor.kind === "oidc") return actor.label;
  return actor.label ?? "anonymous";
}

interface Row {
  id: string;
  at_ms: string;
  actor_kind: string;
  actor_label: string;
  actor_user_id: string | null;
  action: string;
  target: string | null;
  outcome: string;
  detail: string | null;
  client_address: string | null;
}

function toEntry(row: Row): AuditEntry {
  return {
    id: row.id,
    atUnixMs: Number(row.at_ms),
    actor: {
      kind:
        row.actor_kind === "password" || row.actor_kind === "oidc"
          ? row.actor_kind
          : "anonymous",
      label: row.actor_label,
      ...(row.actor_user_id === null ? {} : { userId: row.actor_user_id }),
    },
    action: row.action as AuditAction,
    outcome: row.outcome === "ok" ? "ok" : "failed",
    ...(row.target === null ? {} : { target: row.target }),
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.client_address === null
      ? {}
      : { clientAddress: row.client_address }),
  };
}

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async insert(record: AuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log
         (actor_kind, actor_label, actor_user_id, action, target, outcome, detail, client_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.actor.kind,
        clip(labelOf(record.actor), 320) ?? "unknown",
        record.actor.kind === "oidc" ? record.actor.userId : null,
        record.action,
        clip(record.target, 64),
        record.outcome,
        clip(record.detail, 64),
        clip(record.clientAddress, 64),
      ],
    );
  }

  async list(limit: number, before?: string): Promise<AuditEntry[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id::text, (extract(epoch FROM at) * 1000)::bigint::text AS at_ms, actor_kind,
              actor_label, actor_user_id::text, action, target, outcome, detail, client_address
         FROM audit_log
        WHERE ($2::bigint IS NULL OR audit_log.id < $2::bigint)
        -- Qualified: a bare "id" here is the text output column, which sorts "9" before "13".
        ORDER BY audit_log.id DESC
        LIMIT $1`,
      [limit, before ?? null],
    );
    return rows.map(toEntry);
  }

  async prune(retentionDays: number): Promise<void> {
    await this.pool.query(
      "DELETE FROM audit_log WHERE at < now() - $1 * interval '1 day'",
      [retentionDays],
    );
  }
}

/** In-process entries: the receiver-only test app, which has no database. Bounded. */
export class MemoryAuditStore implements AuditStore {
  readonly entries: AuditEntry[] = [];
  private next = 1;

  async insert(record: AuditRecord): Promise<void> {
    const entry: AuditEntry = {
      id: String(this.next++),
      atUnixMs: Date.now(),
      actor: {
        kind: record.actor.kind,
        label: labelOf(record.actor),
        ...(record.actor.kind === "oidc"
          ? { userId: String(record.actor.userId) }
          : {}),
      },
      action: record.action,
      outcome: record.outcome,
      ...(record.target === undefined ? {} : { target: record.target }),
      ...(record.detail === undefined ? {} : { detail: record.detail }),
      ...(record.clientAddress === undefined
        ? {}
        : { clientAddress: record.clientAddress }),
    };
    this.entries.unshift(entry);
    if (this.entries.length > 1000) this.entries.length = 1000;
  }

  async list(limit: number, before?: string): Promise<AuditEntry[]> {
    return this.entries
      .filter((e) => before === undefined || Number(e.id) < Number(before))
      .slice(0, limit);
  }

  async prune(): Promise<void> {}
}

const PRUNE_EVERY_MS = 60 * 60 * 1000;

export class AuditLog {
  private readonly logger = new Logger("NestrixAudit");
  private lastWarnMs = 0;
  private lastPruneMs = 0;

  constructor(
    private store: AuditStore = new MemoryAuditStore(),
    private readonly retentionDays = 7,
  ) {}

  /** Called once at start by the module that owns the database (or by tests). */
  useStore(store: AuditStore): void {
    this.store = store;
  }

  /** Writes one entry. Never rejects, never throws (see the file comment). */
  record(record: AuditRecord): Promise<void> {
    let pending: Promise<void>;
    try {
      pending = this.store.insert(record);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      () => this.maybePrune(),
      () => this.warn(`audit entry "${record.action}" could not be written`),
    );
  }

  list(limit: number, before?: string): Promise<AuditEntry[]> {
    return this.store.list(limit, before);
  }

  private maybePrune(): void {
    try {
      const now = Date.now();
      if (now - this.lastPruneMs < PRUNE_EVERY_MS) return;
      this.lastPruneMs = now;
      this.store
        .prune(this.retentionDays)
        .catch(() => this.warn("old audit entries could not be deleted"));
    } catch {
      // Housekeeping: the next write tries again.
    }
  }

  private warn(message: string): void {
    try {
      const now = Date.now();
      if (now - this.lastWarnMs < 60_000) return;
      this.lastWarnMs = now;
      this.logger.warn(`${message} (database unavailable?)`);
    } catch {
      // Logging must not affect the request.
    }
  }
}
