/**
 * The `traces` summary table: one row per trace, upserted in the same transaction as the trace's
 * newly inserted spans.
 *
 * Why a table and not a query over `spans`: the trace list needs, per trace, its root's fields,
 * its span count and "does any span name match", newest first with cursors and filters. Computed
 * from `spans` at query time that is a GROUP BY over every span in the window for each page; a
 * row per trace keeps the list a single indexed scan, and the cost moves to ingest, where it is
 * one row write per trace per batch.
 *
 * The root (mirroring the embedded store's `chooseRoot`, across batches and services): the
 * earliest-starting span whose parent is not stored. In a batch, the candidates are the trace's
 * spans whose parent is not in the batch; a candidate with no parent at all is preferred over one
 * with a parent (OTLP does not say whether a parent is remote, so "no parent" is the only proof of
 * a true root), then the earliest start. Merged with the stored row:
 * - the stored root's parent arrived in this batch: the batch's candidate replaces it;
 * - otherwise a parentless root beats a root with a parent, and then the earlier start wins.
 * A candidate from another environment than the stored row never replaces it (D-101).
 * So a trace whose spans arrive from several services in any order settles on its true root once
 * that arrives, and on its earliest span otherwise.
 *
 * Row fields from the root: name, kind, service, start, duration, method, route, status code,
 * error (status error), trace type, release (`service.version` of the root's resource),
 * environment (the root's, D-101).
 * `has_errors` (D-94): any span failed (`SpanRow.isFailure`), merged by OR; a row from before
 * migration 0012 (`NULL`) starts from `error_count > 0`. `user_id`
 * is the root's `user.id`, else the first `user.id` seen in the trace. Aggregates: span and error
 * counts (newly inserted spans only, so a retried export does not count twice), distinct services,
 * distinct span names (at most 64, each cut to 256 characters) for `search`.
 * `indexed_attributes` (issue #27, D-102): per `NESTRIX_INDEXED_ATTRIBUTES` key, the root's value,
 * else the stored one, else the first one in the batch (the `user_id` rule, key by key); `NULL`
 * when the trace has none. `request_ids`: the distinct recorded `x-request-id` values of every
 * span, at most 16, for `search`; `NULL` when there are none.
 *
 * `partition_time` is fixed when the row is created (the earliest start among the creating
 * batch's spans) so the row never moves partition; `seq` is a creation sequence for cursors. The
 * read-merge-write runs under a transaction advisory lock (`TRACES_LOCK`), so two writers (or two
 * server instances) never create two rows for one trace.
 */
import type { PoolClient } from "pg";
import type { SpanRow } from "./derive.js";
import { ADVISORY_CLASS, TRACES_LOCK } from "./locks.js";

export const MAX_SPAN_NAMES = 64;
export const MAX_SPAN_NAME_LENGTH = 256;
/** Request ids kept per trace (D-102). */
export const MAX_TRACE_REQUEST_IDS = 16;

interface StoredTrace {
  trace_id: string;
  /** As Postgres prints it, so it round-trips at microsecond precision. */
  partition_time: string;
  seq: string;
  root_span_id: string;
  root_parent_span_id: string | null;
  environment: string | null;
  start_ns: string;
  user_id: string | null;
  span_count: number;
  error_count: number;
  services: string[];
  span_names: string[];
  indexed_attributes: Record<string, string> | null;
  request_ids: string[] | null;
}

interface TraceUpsert {
  traceId: string;
  partitionTime: string;
  seq: string | null;
  root: SpanRow | null;
  /** Kept root fields when the stored root stays (root is null then). */
  userId: string | null;
  spanCount: number;
  errorCount: number;
  /** Any span of this batch is a job span; merged with the stored flag by OR in SQL. */
  hasJob: boolean;
  /** Any span of this batch failed; merged with the stored flag by OR in SQL (D-94). */
  hasErrors: boolean;
  services: string[];
  spanNames: string[];
  /** D-102: merged per key; `null` when none. */
  indexedAttributes: Record<string, string> | null;
  /** D-102: merged and capped; `null` when none. */
  requestIds: string[] | null;
}

/**
 * Indexed attributes (D-102), key by key: `first` wins over `second`, which wins over the batch's
 * spans in order. `null` when no key has a value.
 */
export function mergeIndexed(
  first: Record<string, string> | null,
  second: Record<string, string> | null,
  spans: readonly SpanRow[],
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const source of [
    first,
    second,
    ...spans.map((s) => s.indexedAttributes),
  ]) {
    if (source === null) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!Object.hasOwn(out, key)) out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function mergeRequestIds(
  stored: readonly string[] | null,
  spans: readonly SpanRow[],
): string[] | null {
  const set = new Set(stored ?? []);
  for (const span of spans) {
    for (const id of span.requestIds) {
      if (set.size >= MAX_TRACE_REQUEST_IDS) break;
      set.add(id);
    }
  }
  return set.size > 0 ? [...set] : null;
}

/** Better root between two candidates, by "parentless first, then earliest start". */
function better(a: SpanRow, b: SpanRow): SpanRow {
  const aRoot = a.parentSpanId === null;
  const bRoot = b.parentSpanId === null;
  if (aRoot !== bRoot) return aRoot ? a : b;
  return b.startNs < a.startNs ? b : a;
}

/** The batch's root candidate of one trace's spans (all from this batch, all newly inserted). */
export function batchCandidate(spans: readonly SpanRow[]): SpanRow {
  const ids = new Set(spans.map((s) => s.spanId));
  let best: SpanRow | undefined;
  for (const s of spans) {
    if (s.parentSpanId !== null && ids.has(s.parentSpanId)) continue;
    best = best === undefined ? s : better(best, s);
  }
  if (best !== undefined) return best;
  // Every span's parent is in the batch: only with a parent cycle (forged ids). Earliest wins.
  let earliest = spans[0] as SpanRow;
  for (const s of spans) if (s.startNs < earliest.startNs) earliest = s;
  return earliest;
}

function mergeNames(into: string[], add: Iterable<string>): string[] {
  const set = new Set(into);
  for (const raw of add) {
    if (set.size >= MAX_SPAN_NAMES) break;
    set.add(
      raw.length > MAX_SPAN_NAME_LENGTH
        ? raw.slice(0, MAX_SPAN_NAME_LENGTH)
        : raw,
    );
  }
  return [...set];
}

/**
 * Upserts the summary rows of the traces of `inserted` (the spans this transaction inserted).
 * Runs inside the caller's transaction.
 */
export async function upsertTraces(
  client: PoolClient,
  inserted: readonly SpanRow[],
  resourceIds: ReadonlyMap<string, number>,
): Promise<number> {
  if (inserted.length === 0) return 0;
  const byTrace = new Map<string, SpanRow[]>();
  for (const s of inserted) {
    const list = byTrace.get(s.traceId);
    if (list) list.push(s);
    else byTrace.set(s.traceId, [s]);
  }
  const traceIds = [...byTrace.keys()].sort();

  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
    ADVISORY_CLASS,
    TRACES_LOCK,
  ]);
  const { rows } = await client.query<StoredTrace>(
    `SELECT trace_id, partition_time::text AS partition_time, seq::text AS seq, root_span_id, root_parent_span_id,
            environment, start_ns::text AS start_ns, user_id, span_count, error_count, services, span_names,
            indexed_attributes, request_ids
       FROM traces WHERE trace_id = ANY($1::text[])
      ORDER BY seq`,
    [traceIds],
  );
  const stored = new Map<string, StoredTrace>();
  for (const r of rows) if (!stored.has(r.trace_id)) stored.set(r.trace_id, r);

  const upserts: TraceUpsert[] = [];
  for (const traceId of traceIds) {
    const spans = byTrace.get(traceId) as SpanRow[];
    const candidate = batchCandidate(spans);
    const existing = stored.get(traceId);
    const errors = spans.filter((s) => s.isError).length;
    const services = new Set(spans.map((s) => s.serviceName));
    const names = spans.map((s) => s.name);
    const hasJob = spans.some((s) => s.isJob);
    const hasErrors = spans.some((s) => s.isFailure);
    const firstUser = spans.find((s) => s.userId !== null)?.userId ?? null;
    if (existing === undefined) {
      let earliest = spans[0] as SpanRow;
      for (const s of spans) if (s.startNs < earliest.startNs) earliest = s;
      upserts.push({
        traceId,
        partitionTime: earliest.startTime,
        seq: null,
        root: candidate,
        userId: candidate.userId ?? firstUser,
        spanCount: spans.length,
        errorCount: errors,
        hasJob,
        hasErrors,
        services: [...services].sort(),
        spanNames: mergeNames([], names),
        indexedAttributes: mergeIndexed(
          candidate.indexedAttributes,
          null,
          spans,
        ),
        requestIds: mergeRequestIds(null, spans),
      });
      continue;
    }
    const ids = new Set(spans.map((s) => s.spanId));
    const storedIsRoot = existing.root_parent_span_id === null;
    const candidateIsRoot = candidate.parentSpanId === null;
    let replace: boolean;
    if (
      existing.root_parent_span_id !== null &&
      ids.has(existing.root_parent_span_id)
    ) {
      replace = true;
    } else if (storedIsRoot !== candidateIsRoot) {
      replace = candidateIsRoot;
    } else {
      replace = candidate.startNs < BigInt(existing.start_ns);
    }
    // A span of another environment never takes over the stored root: one environment's key must
    // not be able to move another's trace by sending an earlier or parentless span for a known
    // trace id (D-101). Its spans are still stored and counted.
    if (candidate.environment !== existing.environment) replace = false;
    const root = replace ? candidate : null;
    upserts.push({
      traceId,
      partitionTime: existing.partition_time,
      seq: existing.seq,
      root,
      userId:
        (replace ? candidate.userId : null) ?? existing.user_id ?? firstUser,
      spanCount: existing.span_count + spans.length,
      errorCount: existing.error_count + errors,
      hasJob,
      hasErrors,
      services: [...new Set([...existing.services, ...services])].sort(),
      spanNames: mergeNames(existing.span_names, names),
      indexedAttributes: mergeIndexed(
        replace ? candidate.indexedAttributes : null,
        existing.indexed_attributes,
        spans,
      ),
      requestIds: mergeRequestIds(existing.request_ids, spans),
    });
  }

  // Rows whose root changes (or are new) get every column; the others only the aggregates.
  const full = upserts.filter((u) => u.root !== null);
  const partial = upserts.filter((u) => u.root === null);
  if (full.length > 0) {
    const col = <T>(f: (u: TraceUpsert, r: SpanRow) => T): T[] =>
      full.map((u) => f(u, u.root as SpanRow));
    await client.query(
      `INSERT INTO traces (
         trace_id, partition_time, seq, root_span_id, root_parent_span_id, resource_id,
         service_name, name, kind, start_time, start_ns, duration_ns, http_method, http_route,
         http_status, is_error, trace_type, release, user_id, span_count, error_count,
         services, span_names, has_job, has_errors, environment, indexed_attributes,
         request_ids)
       SELECT u.trace_id, u.partition_time, coalesce(u.seq, nextval('traces_seq')),
              u.root_span_id, u.root_parent_span_id, u.resource_id, u.service_name, u.name,
              u.kind, u.start_time, u.start_ns, u.duration_ns, u.http_method, u.http_route,
              u.http_status, u.is_error, u.trace_type, u.release, u.user_id, u.span_count,
              u.error_count,
              ARRAY(SELECT jsonb_array_elements_text(u.services::jsonb)),
              ARRAY(SELECT jsonb_array_elements_text(u.span_names::jsonb)),
              u.has_job, u.has_errors, u.environment, u.indexed_attributes::jsonb,
              CASE WHEN u.request_ids IS NULL THEN NULL
                   ELSE ARRAY(SELECT jsonb_array_elements_text(u.request_ids::jsonb)) END
         FROM unnest(
           $1::text[], $2::timestamptz[], $3::bigint[], $4::text[], $5::text[], $6::bigint[],
           $7::text[], $8::text[], $9::text[], $10::timestamptz[], $11::bigint[], $12::bigint[],
           $13::text[], $14::text[], $15::int[], $16::boolean[], $17::text[], $18::text[],
           $19::text[], $20::int[], $21::int[], $22::text[], $23::text[], $24::boolean[],
           $25::boolean[], $26::text[], $27::text[], $28::text[]
         ) AS u(trace_id, partition_time, seq, root_span_id, root_parent_span_id, resource_id,
                service_name, name, kind, start_time, start_ns, duration_ns, http_method,
                http_route, http_status, is_error, trace_type, release, user_id, span_count,
                error_count, services, span_names, has_job, has_errors, environment,
                indexed_attributes,
                request_ids)
       ON CONFLICT (trace_id, partition_time) DO UPDATE SET
         root_span_id = EXCLUDED.root_span_id,
         root_parent_span_id = EXCLUDED.root_parent_span_id,
         resource_id = EXCLUDED.resource_id,
         service_name = EXCLUDED.service_name,
         environment = EXCLUDED.environment,
         name = EXCLUDED.name,
         kind = EXCLUDED.kind,
         start_time = EXCLUDED.start_time,
         start_ns = EXCLUDED.start_ns,
         duration_ns = EXCLUDED.duration_ns,
         http_method = EXCLUDED.http_method,
         http_route = EXCLUDED.http_route,
         http_status = EXCLUDED.http_status,
         is_error = EXCLUDED.is_error,
         trace_type = EXCLUDED.trace_type,
         release = EXCLUDED.release,
         user_id = EXCLUDED.user_id,
         span_count = EXCLUDED.span_count,
         error_count = EXCLUDED.error_count,
         services = EXCLUDED.services,
         span_names = EXCLUDED.span_names,
         has_job = traces.has_job OR EXCLUDED.has_job,
         has_errors = coalesce(traces.has_errors, traces.error_count > 0) OR EXCLUDED.has_errors,
         indexed_attributes = EXCLUDED.indexed_attributes,
         request_ids = EXCLUDED.request_ids,
         updated_at = now()`,
      [
        col((u) => u.traceId),
        col((u) => u.partitionTime),
        col((u) => u.seq),
        col((_, r) => r.spanId),
        col((_, r) => r.parentSpanId),
        col((_, r) => resourceIds.get(r.resourceHash) ?? null),
        col((_, r) => r.serviceName),
        col((_, r) => r.name),
        col((_, r) => r.kind),
        col((_, r) => r.startTime),
        col((_, r) => r.startNs.toString()),
        col((_, r) => r.durationNs.toString()),
        col((_, r) => r.httpMethod),
        col((_, r) => r.httpRoute),
        col((_, r) => r.httpStatus),
        col((_, r) => r.isError),
        col((_, r) => r.traceType),
        col((_, r) => r.release),
        col((u) => u.userId),
        col((u) => u.spanCount),
        col((u) => u.errorCount),
        col((u) => JSON.stringify(u.services)),
        col((u) => JSON.stringify(u.spanNames)),
        col((u) => u.hasJob),
        col((u) => u.hasErrors),
        col((_, r) => r.environment),
        col((u) =>
          u.indexedAttributes === null
            ? null
            : JSON.stringify(u.indexedAttributes),
        ),
        col((u) =>
          u.requestIds === null ? null : JSON.stringify(u.requestIds),
        ),
      ],
    );
  }
  if (partial.length > 0) {
    await client.query(
      `UPDATE traces t SET
         user_id = u.user_id,
         span_count = u.span_count,
         error_count = u.error_count,
         services = ARRAY(SELECT jsonb_array_elements_text(u.services::jsonb)),
         span_names = ARRAY(SELECT jsonb_array_elements_text(u.span_names::jsonb)),
         has_job = t.has_job OR u.has_job,
         has_errors = coalesce(t.has_errors, t.error_count > 0) OR u.has_errors,
         indexed_attributes = u.indexed_attributes::jsonb,
         request_ids = CASE WHEN u.request_ids IS NULL THEN NULL
                            ELSE ARRAY(SELECT jsonb_array_elements_text(u.request_ids::jsonb)) END,
         updated_at = now()
         FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::int[], $5::int[],
                     $6::text[], $7::text[], $8::boolean[], $9::boolean[], $10::text[],
                     $11::text[])
              AS u(trace_id, partition_time, user_id, span_count, error_count, services,
                   span_names, has_job, has_errors, indexed_attributes, request_ids)
        WHERE t.trace_id = u.trace_id AND t.partition_time = u.partition_time`,
      [
        partial.map((u) => u.traceId),
        partial.map((u) => u.partitionTime),
        partial.map((u) => u.userId),
        partial.map((u) => u.spanCount),
        partial.map((u) => u.errorCount),
        partial.map((u) => JSON.stringify(u.services)),
        partial.map((u) => JSON.stringify(u.spanNames)),
        partial.map((u) => u.hasJob),
        partial.map((u) => u.hasErrors),
        partial.map((u) =>
          u.indexedAttributes === null
            ? null
            : JSON.stringify(u.indexedAttributes),
        ),
        partial.map((u) =>
          u.requestIds === null ? null : JSON.stringify(u.requestIds),
        ),
      ],
    );
  }
  return upserts.length;
}
