/**
 * Drizzle table definitions for the query side (P5-03) and for tests. They describe what
 * `migrations/*.sql` creates; the SQL is the source of truth (Drizzle cannot express the
 * partitioning) and `test/storage/schema.test.ts` fails when the two drift.
 *
 * Partitioned tables are queried through their parents (`spans`, `traces`, `route_minutes`,
 * `class_minutes`); Postgres prunes partitions from a `start_time` / `partition_time` /
 * `minute` range in the WHERE clause.
 *
 * Column semantics (the rules are in `derive.ts` and `traces.ts`):
 * - `*_ns` are Unix nanoseconds (bigint mode: JS `bigint`); `start_time` is the same instant.
 * - `spans.is_error` / `traces.is_error`: status code `error` (the embedded error definition).
 * - `traces` holds one row per trace with its root's fields; list traces from it.
 * - `route_minutes` / `class_minutes`: per-minute rollups with a 30-bucket latency histogram
 *   (`histogram.ts`: `addHistograms`, `estimateQuantile`).
 */
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const tz = { withTimezone: true, mode: "date" } as const;

export interface StoredEvent {
  name: string;
  /** Unix nanoseconds as a decimal string. */
  timeUnixNano: string;
  attributes: Record<string, unknown>;
}

export interface StoredLink {
  traceId: string;
  spanId: string;
  attributes: Record<string, unknown>;
}

export const resources = pgTable("resources", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  hash: text("hash").notNull().unique(),
  serviceName: text("service_name").notNull(),
  serviceVersion: text("service_version"),
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

export const services = pgTable("services", {
  name: text("name").primaryKey(),
  lastSeen: timestamp("last_seen", tz).notNull(),
});

/** (service, environment) pairs seen (migration 0016, D-101); unique NULLS NOT DISTINCT. */
export const serviceEnvironments = pgTable("service_environments", {
  serviceName: text("service_name").notNull(),
  environment: text("environment"),
  lastSeen: timestamp("last_seen", tz).notNull(),
});

export const spans = pgTable(
  "spans",
  {
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    resourceId: bigint("resource_id", { mode: "number" }).notNull(),
    serviceName: text("service_name").notNull(),
    name: text("name").notNull(),
    kind: text("kind")
      .$type<"server" | "client" | "internal" | "producer" | "consumer">()
      .notNull(),
    startTime: timestamp("start_time", tz).notNull(),
    startNs: bigint("start_ns", { mode: "bigint" }).notNull(),
    endNs: bigint("end_ns", { mode: "bigint" }).notNull(),
    durationNs: bigint("duration_ns", { mode: "bigint" }).notNull(),
    statusCode: text("status_code").$type<"unset" | "ok" | "error">().notNull(),
    statusMessage: text("status_message"),
    scope: text("scope"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull(),
    events: jsonb("events").$type<StoredEvent[]>().notNull(),
    links: jsonb("links").$type<StoredLink[]>().notNull(),
    httpRoute: text("http_route"),
    httpMethod: text("http_method"),
    httpStatus: integer("http_status"),
    isRoot: boolean("is_root").notNull(),
    isError: boolean("is_error").notNull(),
    traceType: text("trace_type")
      .$type<"http" | "job" | "scheduled" | "other">()
      .notNull(),
    userId: text("user_id"),
    className: text("class_name"),
    methodName: text("method_name"),
    /** Error occurrence before the legacy parent rule (migration 0012, D-93); `NULL` on older rows. */
    isOccurrence: boolean("is_occurrence"),
    /** Hash of the primary exception (migration 0012, D-93). */
    errorKey: text("error_key"),
    /** `deployment.environment.name` of the resource, or the ingest key's (migration 0016, D-101); `NULL` is unset. */
    environment: text("environment"),
    /**
     * Ingest order (migration 0023, D-114): `nextval('spans_ingest_seq')` by default, taken under
     * `TRACES_LOCK`, so committed in order. `NULL` on rows stored before the migration.
     */
    ingestSeq: bigint("ingest_seq", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.traceId, t.spanId, t.startTime] })],
);

export const traces = pgTable(
  "traces",
  {
    traceId: text("trace_id").notNull(),
    partitionTime: timestamp("partition_time", tz).notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    rootSpanId: text("root_span_id").notNull(),
    rootParentSpanId: text("root_parent_span_id"),
    resourceId: bigint("resource_id", { mode: "number" }).notNull(),
    serviceName: text("service_name").notNull(),
    name: text("name").notNull(),
    kind: text("kind")
      .$type<"server" | "client" | "internal" | "producer" | "consumer">()
      .notNull(),
    startTime: timestamp("start_time", tz).notNull(),
    startNs: bigint("start_ns", { mode: "bigint" }).notNull(),
    durationNs: bigint("duration_ns", { mode: "bigint" }).notNull(),
    httpMethod: text("http_method"),
    httpRoute: text("http_route"),
    httpStatus: integer("http_status"),
    isError: boolean("is_error").notNull(),
    traceType: text("trace_type")
      .$type<"http" | "job" | "scheduled" | "other">()
      .notNull(),
    hasJob: boolean("has_job").notNull().default(false),
    /** Any span failed (migration 0012, D-94); `NULL` on rows stored before it. */
    hasErrors: boolean("has_errors"),
    release: text("release"),
    userId: text("user_id"),
    spanCount: integer("span_count").notNull(),
    errorCount: integer("error_count").notNull(),
    /** Spans not stored because the trace was over the per-trace cap (migration 0010, D-78). */
    droppedSpans: bigint("dropped_spans", { mode: "number" })
      .notNull()
      .default(0),
    services: text("services").array().notNull(),
    spanNames: text("span_names").array().notNull(),
    /** `NESTRIX_INDEXED_ATTRIBUTES` values as text, by key (migration 0017, D-102); `NULL`: none. */
    indexedAttributes:
      jsonb("indexed_attributes").$type<Record<string, string>>(),
    /** Recorded `x-request-id` values (migration 0017, D-102); `NULL`: none. */
    requestIds: text("request_ids").array(),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
    /** `deployment.environment.name` of the root's resource, or the ingest key's (migration 0016, D-101); `NULL` is unset. */
    environment: text("environment"),
  },
  (t) => [primaryKey({ columns: [t.traceId, t.partitionTime] })],
);

export const routeMinutes = pgTable("route_minutes", {
  minute: timestamp("minute", tz).notNull(),
  serviceName: text("service_name").notNull(),
  method: text("method").notNull(),
  route: text("route").notNull(),
  count: integer("count").notNull(),
  errors: integer("errors").notNull(),
  totalMs: doublePrecision("total_ms").notNull(),
  maxMs: doublePrecision("max_ms").notNull(),
  hist: integer("hist").array().notNull(),
  /** Part of the key (migration 0016, D-101): unique on (minute, service, environment, method, route), NULLS NOT DISTINCT. */
  environment: text("environment"),
});

export const classMinutes = pgTable("class_minutes", {
  minute: timestamp("minute", tz).notNull(),
  serviceName: text("service_name").notNull(),
  className: text("class_name").notNull(),
  methodName: text("method_name").notNull(),
  classKind: text("class_kind").notNull(),
  count: integer("count").notNull(),
  errors: integer("errors").notNull(),
  totalMs: doublePrecision("total_ms").notNull(),
  maxMs: doublePrecision("max_ms").notNull(),
  hist: integer("hist").array().notNull(),
  /** Part of the key (migration 0016, D-101): unique on (minute, service, environment, class, method), NULLS NOT DISTINCT. */
  environment: text("environment"),
});

/** Log lines next to their trace (migrations/0007_logs.sql, src/storage/logs.ts; P9-07). */
export const logs = pgTable(
  "logs",
  {
    traceId: text("trace_id").notNull(),
    spanId: text("span_id"),
    time: timestamp("time", tz).notNull(),
    timeNs: bigint("time_ns", { mode: "bigint" }).notNull(),
    severityNumber: integer("severity_number").notNull(),
    severityText: text("severity_text").notNull(),
    body: text("body").notNull(),
    context: text("context"),
    serviceName: text("service_name").notNull(),
    recordHash: text("record_hash").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    /** `deployment.environment.name` of the resource, or the ingest key's (migration 0016, D-101); `NULL` is unset. */
    environment: text("environment"),
  },
  (t) => [primaryKey({ columns: [t.traceId, t.recordHash, t.time] })],
);

/** Log lines not stored, per UTC day and reason (migrations/0021_logs_search.sql). */
export const logDrops = pgTable(
  "log_drops",
  {
    day: date("day").notNull(),
    reason: text("reason").notNull(),
    dropped: bigint("dropped", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.reason] })],
);

/** Optional historical metrics (migrations/0020_metric_minutes.sql, src/storage/metrics.ts; issue #18, D-105). */
export const metricMinutes = pgTable("metric_minutes", {
  minute: timestamp("minute", tz).notNull(),
  serviceName: text("service_name").notNull(),
  /** Part of the key (D-101): unique on (service, environment, metric, instance, series, minute), NULLS NOT DISTINCT. */
  environment: text("environment"),
  instanceId: text("instance_id").notNull(),
  metricName: text("metric_name").notNull(),
  seriesKey: text("series_key").notNull(),
  attributes: jsonb("attributes").notNull(),
  kind: text("kind").$type<"gauge" | "counter" | "histogram">().notNull(),
  temporality: text("temporality").$type<"cumulative" | "delta">().notNull(),
  timeNs: bigint("time_ns", { mode: "bigint" }).notNull(),
  startNs: bigint("start_ns", { mode: "bigint" }).notNull(),
  lastValue: doublePrecision("last_value"),
  sumValue: doublePrecision("sum_value"),
  countValue: bigint("count_value", { mode: "number" }),
  minValue: doublePrecision("min_value"),
  maxValue: doublePrecision("max_value"),
  bounds: doublePrecision("bounds").array(),
  buckets: doublePrecision("buckets").array(),
  histCount: doublePrecision("hist_count"),
  histSum: doublePrecision("hist_sum"),
});

/** Alerting (migrations/0002_alerts.sql, src/alerts/). */
export const alertRules = pgTable("alert_rules", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  // NULL only for a `new_error_group` rule (migrations/0018_error_triage.sql): every service.
  serviceName: text("service_name"),
  route: text("route"),
  metric: text("metric")
    .$type<"error_rate" | "p95_ms" | "slo_burn_rate" | "new_error_group">()
    .notNull(),
  sloId: bigint("slo_id", { mode: "number" }),
  comparator: text("comparator").$type<">">().notNull().default(">"),
  threshold: doublePrecision("threshold").notNull(),
  windowMinutes: integer("window_minutes").notNull(),
  forMinutes: integer("for_minutes").notNull().default(2),
  minRequests: integer("min_requests").notNull().default(10),
  webhookUrl: text("webhook_url").notNull(),
  secret: text("secret").notNull(),
  /** Migration 0016 (D-101): `NULL` watches every environment, `unset` rows without one. */
  environment: text("environment"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

/** SLOs (migrations/0003_slos.sql, src/slos/). */
export const slos = pgTable("slos", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  serviceName: text("service_name").notNull(),
  route: text("route"),
  kind: text("kind").$type<"availability" | "latency">().notNull(),
  latencyThresholdMs: doublePrecision("latency_threshold_ms"),
  objective: doublePrecision("objective").notNull(),
  windowDays: integer("window_days").notNull(),
  /** Migration 0016 (D-101): `NULL` covers every environment, `unset` rows without one. */
  environment: text("environment"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

/** API tokens (migrations/0006_api_tokens.sql, src/auth/api-tokens.ts). `hash` is hex SHA-256. */
export const apiTokens = pgTable("api_tokens", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  hash: text("hash").notNull().unique(),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", tz),
  revokedAt: timestamp("revoked_at", tz),
});

export const alertState = pgTable("alert_state", {
  ruleId: bigint("rule_id", { mode: "number" }).primaryKey(),
  state: text("state").$type<"ok" | "pending" | "firing">().notNull(),
  since: timestamp("since", tz).notNull(),
  lastValue: doublePrecision("last_value"),
  lastEvaluatedAt: timestamp("last_evaluated_at", tz).notNull(),
  lastNotifiedAt: timestamp("last_notified_at", tz),
});

export const alertEvents = pgTable("alert_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  ruleId: bigint("rule_id", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  kind: text("kind").$type<"firing" | "resolved" | "test">().notNull(),
  value: doublePrecision("value"),
  threshold: doublePrecision("threshold").notNull(),
  delivery: text("delivery")
    .$type<"pending" | "sent" | "failed" | "refused">()
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  responseStatus: integer("response_status"),
  error: text("error"),
});

/** Error triage (migrations/0018_error_triage.sql, src/errors/). */
export const errorGroups = pgTable(
  "error_groups",
  {
    serviceName: text("service_name").notNull(),
    /** `''` is the unset environment (D-101; part of the key, so not NULL as elsewhere). */
    environment: text("environment").notNull().default(""),
    keyHash: text("key_hash").notNull(),
    groupKey: text("group_key").notNull(),
    errorType: text("error_type"),
    pattern: text("pattern").notNull(),
    route: text("route"),
    state: text("state")
      .$type<"open" | "resolved" | "regressed" | "ignored">()
      .notNull()
      .default("open"),
    firstSeen: timestamp("first_seen", tz).notNull(),
    lastSeen: timestamp("last_seen", tz).notNull(),
    firstRelease: text("first_release"),
    lastRelease: text("last_release"),
    occurrences: bigint("occurrences", { mode: "number" }).notNull().default(0),
    resolvedAt: timestamp("resolved_at", tz),
    resolvedInRelease: text("resolved_in_release"),
    regressedAt: timestamp("regressed_at", tz),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
    regressedDetectedAt: timestamp("regressed_detected_at", tz),
    regressions: integer("regressions").notNull().default(0),
    ignoredAt: timestamp("ignored_at", tz),
  },
  (t) => [primaryKey({ columns: [t.serviceName, t.environment, t.keyHash] })],
);

export const errorGroupReleases = pgTable(
  "error_group_releases",
  {
    serviceName: text("service_name").notNull(),
    /** `''` is the unset environment (D-101; part of the key, so not NULL as elsewhere). */
    environment: text("environment").notNull().default(""),
    keyHash: text("key_hash").notNull(),
    release: text("release").notNull(),
    firstSeen: timestamp("first_seen", tz).notNull(),
    lastSeen: timestamp("last_seen", tz).notNull(),
    occurrences: bigint("occurrences", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({
      columns: [t.serviceName, t.environment, t.keyHash, t.release],
    }),
  ],
);

export const errorGroupSync = pgTable("error_group_sync", {
  id: smallint("id").primaryKey(),
  /** The previous release's start-time watermark; parked ahead of the clock since D-114. */
  watermark: timestamp("watermark", tz).notNull(),
  /** Migration 0023 (D-114): the ingest-order watermark; `NULL` until the switch. */
  seqWatermark: bigint("seq_watermark", { mode: "number" }),
  /** Rows at or below it (or `NULL`) were stored before the switch, read by start time. */
  legacySeq: bigint("legacy_seq", { mode: "number" }),
  legacyWatermark: timestamp("legacy_watermark", tz),
  legacyUntil: timestamp("legacy_until", tz),
});

export const errorGroupAlerts = pgTable(
  "error_group_alerts",
  {
    ruleId: bigint("rule_id", { mode: "number" }).notNull(),
    serviceName: text("service_name").notNull(),
    /** `''` is the unset environment (D-101; part of the key, so not NULL as elsewhere). */
    environment: text("environment").notNull().default(""),
    keyHash: text("key_hash").notNull(),
    episode: integer("episode").notNull(),
    eventId: bigint("event_id", { mode: "number" }),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.ruleId, t.serviceName, t.environment, t.keyHash, t.episode],
    }),
  ],
);

export const schema = {
  resources,
  services,
  serviceEnvironments,
  spans,
  traces,
  routeMinutes,
  classMinutes,
  logs,
  metricMinutes,
  slos,
  apiTokens,
  alertRules,
  alertState,
  alertEvents,
  errorGroups,
  errorGroupReleases,
  errorGroupSync,
  errorGroupAlerts,
};
export type StorageSchema = typeof schema;
