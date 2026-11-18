/**
 * Stored triage state of error groups (issue #26, D-103): the row shapes, the pure rules that
 * combine rows into what a list reports, and the writes behind the resolve, ignore and reopen
 * routes. The sync that fills the table is `sync.ts`.
 *
 * A group is stored per (service, environment, group key); the key is `groupKeyOf` of
 * `query/error-groups.ts` (the one place that defines a group's identity), hashed so the primary
 * key stays small. The environment (issue #28, D-101) is stored as `''` when unset (migration
 * 0018 says why), so triage in one environment never changes another's copy of the group.
 */
import { createHash } from "node:crypto";
import type {
  ErrorGroup,
  ErrorGroupTriage,
  ErrorGroupTriageState,
} from "@nestrix-js/protocol";
import type { Pool, PoolClient } from "pg";
import { groupKeyOf } from "../query/error-groups.js";
import { type Scope, UNSET_ENVIRONMENT } from "../query/scope.js";

export type TriageAction = "resolve" | "ignore" | "reopen";

export const keyHashOf = (key: string): string =>
  createHash("sha256").update(key).digest("hex");

/** The stored form of a record's environment: `''` for none (`null` or absent). */
export const storedEnvironment = (
  environment: string | null | undefined,
): string => environment ?? "";

/**
 * The stored form of a scope's environment: `undefined` for every environment, `''` for `unset`,
 * the name otherwise.
 */
export const scopeEnvironment = (
  environment: string | null | undefined,
): string | undefined => {
  if (environment === undefined || environment === null) return undefined;
  return environment === UNSET_ENVIRONMENT ? "" : environment;
};

/** Map key of a stored row: service, stored environment and key hash. */
export const rowKey = (
  service: string,
  environment: string,
  hash: string,
): string => `${service}\u0000${environment}\u0000${hash}`;

/** Where a group was seen: one service in one environment (`''` unset). */
export interface GroupPlace {
  service: string;
  environment: string;
}

/** The columns of `error_groups` the query API reads. */
export interface TriageRow {
  service_name: string;
  environment: string;
  key_hash: string;
  state: ErrorGroupTriageState;
  resolved_at: Date | null;
  resolved_in_release: string | null;
  regressed_at: Date | null;
  ignored_at: Date | null;
}

const TRIAGE_COLUMNS =
  "service_name, environment, key_hash, state, resolved_at, resolved_in_release, regressed_at, ignored_at";
/** More stored non-open groups than this are not all read (a person triages tens, not thousands). */
const TRIAGED_CAP = 10_000;

/**
 * Every stored group in `scope` that is not open (what lists need: they treat a missing row as
 * open).
 */
export async function loadTriaged(
  db: Pool | PoolClient,
  scope: Scope,
): Promise<Map<string, TriageRow>> {
  const values: unknown[] = [TRIAGED_CAP];
  const where = ["state <> 'open'"];
  if (scope.service !== undefined) {
    values.push(scope.service);
    where.push(`service_name = $${values.length}`);
  }
  const environment = scopeEnvironment(scope.environment);
  if (environment !== undefined) {
    values.push(environment);
    where.push(`environment = $${values.length}`);
  }
  const { rows } = await db.query<TriageRow>(
    `SELECT ${TRIAGE_COLUMNS} FROM error_groups
      WHERE ${where.join(" AND ")}
      LIMIT $1`,
    values,
  );
  return new Map(
    rows.map((r) => [rowKey(r.service_name, r.environment, r.key_hash), r]),
  );
}

const PRIORITY: Record<ErrorGroupTriageState, number> = {
  regressed: 0,
  open: 1,
  resolved: 2,
  ignored: 3,
};

function triageOf(row: TriageRow): ErrorGroupTriage {
  const t: ErrorGroupTriage = { state: row.state };
  if (row.state === "resolved" || row.state === "regressed") {
    if (row.resolved_at !== null)
      t.resolvedAtUnixMs = row.resolved_at.getTime();
    if (row.resolved_in_release !== null)
      t.resolvedInRelease = row.resolved_in_release;
  }
  if (row.state === "regressed" && row.regressed_at !== null)
    t.regressedAtUnixMs = row.regressed_at.getTime();
  if (row.state === "ignored" && row.ignored_at !== null)
    t.ignoredAtUnixMs = row.ignored_at.getTime();
  return t;
}

/**
 * The state of a group over the places (service and environment) it was seen in: the most urgent
 * of its stored copies (`regressed`, then `open`, then `resolved`, then `ignored`). A place with
 * no stored non-open row counts as open. `rows` holds the non-open rows only (`loadTriaged`).
 */
export function combineTriage(
  rows: ReadonlyMap<string, TriageRow>,
  places: readonly GroupPlace[],
  key: string,
): ErrorGroupTriage {
  const hash = keyHashOf(key);
  let best: ErrorGroupTriage | undefined;
  const consider = (t: ErrorGroupTriage) => {
    if (best === undefined || PRIORITY[t.state] < PRIORITY[best.state])
      best = t;
  };
  if (places.length === 0) consider({ state: "open" });
  for (const { service, environment } of places) {
    const row = rows.get(rowKey(service, environment, hash));
    consider(row === undefined ? { state: "open" } : triageOf(row));
  }
  return best ?? { state: "open" };
}

export type TriageFilter =
  | "all"
  | "open"
  | "resolved"
  | "regressed"
  | "ignored"
  | undefined;

/** Unset: everything but ignored groups. */
export function passesFilter(
  filter: TriageFilter,
  state: ErrorGroupTriageState,
): boolean {
  if (filter === undefined) return state !== "ignored";
  return filter === "all" || filter === state;
}

/**
 * What `GET errors/groups` does with the stored states: the `include` predicate for `groupErrors`
 * (which drops groups before the list is cut), the annotation of the groups that remain, and the
 * count of ignored groups left out. `placesOf` names where a group was seen in the window; by
 * default its services in the unset environment.
 */
export function triageView(
  rows: ReadonlyMap<string, TriageRow>,
  filter: TriageFilter,
  placesOf: (group: ErrorGroup) => readonly GroupPlace[] = (group) =>
    group.services.map((service) => ({ service, environment: "" })),
) {
  let ignoredCount = 0;
  const states = new Map<string, ErrorGroupTriage>();
  return {
    include(group: ErrorGroup): boolean {
      const triage = combineTriage(rows, placesOf(group), group.key);
      if (!passesFilter(filter, triage.state)) {
        if (filter === undefined && triage.state === "ignored") ignoredCount++;
        return false;
      }
      states.set(group.key, triage);
      return true;
    },
    annotate(group: ErrorGroup): void {
      group.triage = states.get(group.key) ?? { state: "open" };
    },
    get ignoredCount() {
      return ignoredCount;
    },
  };
}

// ---- the group key, parsed back ----------------------------------------------------------------

export interface ParsedKey {
  errorType: string | null;
  pattern: string;
  route: string | null;
}

/**
 * Reads a key sent by a client, accepting only exactly what `groupKeyOf` produces, so the hash is
 * the one the lists compute. Undefined for anything else.
 */
export function parseGroupKey(key: unknown): ParsedKey | undefined {
  if (typeof key !== "string" || key.length === 0 || key.length > 4096) return;
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    return;
  }
  if (!Array.isArray(value) || value.length !== 3) return;
  const [type, pattern, route] = value as unknown[];
  if (type !== null && typeof type !== "string") return;
  if (typeof pattern !== "string") return;
  if (route !== null && typeof route !== "string") return;
  if (groupKeyOf(type ?? undefined, pattern, route ?? undefined) !== key)
    return;
  return { errorType: type, pattern, route };
}

// ---- writes ------------------------------------------------------------------------------------

/**
 * Applies `action` to a group (every service and environment that has it, or only those `service`
 * and `environment` name) and returns what was stored afterwards; undefined when no stored copy
 * matches. `environment` is a scope value (D-101): `undefined` every environment, `unset` the
 * copy without one, any other value that environment. A stored row that does not exist yet (the
 * sync has not seen the group: it runs a few seconds behind ingest) is created for a named
 * `service`, so a person can act on a group they just saw in a list; the sync merges the real
 * first and last occurrence into it. It is created in `environment`, or, when none is named, in
 * the unset environment if the service was never seen with one (`service_environments`), which
 * is what a client that predates environments means; otherwise nothing is created (the call
 * cannot know which environment's group was meant).
 *
 * Resolving records the release of the group's latest occurrence: a later occurrence in another
 * release is a regression (`sync.ts`). Rows are locked first, so a sync run applying a regression
 * and this change happen one after the other.
 */
export async function applyTriage(
  pool: Pool,
  action: TriageAction,
  key: string,
  parsed: ParsedKey,
  service: string | undefined,
  environment: string | undefined,
  nowMs: number,
): Promise<{ updated: number; triage: ErrorGroupTriage } | undefined> {
  const hash = keyHashOf(key);
  const at = new Date(nowMs);
  const env = scopeEnvironment(environment);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let createIn = env;
    if (service !== undefined && createIn === undefined) {
      const named = await client.query(
        `SELECT 1 FROM service_environments
          WHERE service_name = $1 AND environment IS NOT NULL LIMIT 1`,
        [service],
      );
      if ((named.rowCount ?? 0) === 0) createIn = "";
    }
    if (service !== undefined && createIn !== undefined) {
      await client.query(
        `INSERT INTO error_groups
           (service_name, environment, key_hash, group_key, error_type, pattern, route,
            first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (service_name, environment, key_hash) DO NOTHING`,
        [
          service,
          createIn,
          hash,
          key,
          parsed.errorType,
          parsed.pattern,
          parsed.route,
          at,
        ],
      );
    }
    const params: unknown[] = [hash];
    const conditions = ["key_hash = $1"];
    if (service !== undefined) {
      params.push(service);
      conditions.push(`service_name = $${params.length}`);
    }
    if (env !== undefined) {
      params.push(env);
      conditions.push(`environment = $${params.length}`);
    }
    const where = conditions.join(" AND ");
    const locked = await client.query<{ service_name: string }>(
      `SELECT service_name FROM error_groups
        WHERE ${where}
        ORDER BY service_name, environment FOR UPDATE`,
      params,
    );
    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const next = params.length + 1;
    let set: string;
    if (action === "resolve") {
      set = `state = 'resolved', resolved_at = $${next}, resolved_in_release = last_release, ignored_at = NULL`;
    } else if (action === "ignore") {
      set = `state = 'ignored', ignored_at = $${next}, resolved_at = NULL, resolved_in_release = NULL`;
    } else {
      set = `state = 'open', resolved_at = NULL, resolved_in_release = NULL, regressed_at = NULL, ignored_at = NULL`;
    }
    const res = await client.query<TriageRow>(
      `UPDATE error_groups SET ${set} WHERE ${where} RETURNING ${TRIAGE_COLUMNS}`,
      action === "reopen" ? params : [...params, at],
    );
    await client.query("COMMIT");
    const rows = new Map(
      res.rows.map((r) => [
        rowKey(r.service_name, r.environment, r.key_hash),
        r,
      ]),
    );
    return {
      updated: res.rows.length,
      triage: combineTriage(
        rows,
        res.rows.map((r) => ({
          service: r.service_name,
          environment: r.environment,
        })),
        key,
      ),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
