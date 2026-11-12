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
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    release: text("release"),
    userId: text("user_id"),
    spanCount: integer("span_count").notNull(),
    errorCount: integer("error_count").notNull(),
    services: text("services").array().notNull(),
    spanNames: text("span_names").array().notNull(),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.traceId, t.partitionTime] })],
);

export const routeMinutes = pgTable(
  "route_minutes",
  {
    minute: timestamp("minute", tz).notNull(),
    serviceName: text("service_name").notNull(),
    method: text("method").notNull(),
    route: text("route").notNull(),
    count: integer("count").notNull(),
    errors: integer("errors").notNull(),
    totalMs: doublePrecision("total_ms").notNull(),
    maxMs: doublePrecision("max_ms").notNull(),
    hist: integer("hist").array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.minute, t.serviceName, t.method, t.route] }),
  ],
);

export const classMinutes = pgTable(
  "class_minutes",
  {
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
  },
  (t) => [
    primaryKey({
      columns: [t.minute, t.serviceName, t.className, t.methodName],
    }),
  ],
);

/** Alerting (migrations/0002_alerts.sql, src/alerts/). */
export const alertRules = pgTable("alert_rules", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  serviceName: text("service_name").notNull(),
  route: text("route"),
  metric: text("metric")
    .$type<"error_rate" | "p95_ms" | "slo_burn_rate">()
    .notNull(),
  sloId: bigint("slo_id", { mode: "number" }),
  comparator: text("comparator").$type<">">().notNull().default(">"),
  threshold: doublePrecision("threshold").notNull(),
  windowMinutes: integer("window_minutes").notNull(),
  forMinutes: integer("for_minutes").notNull().default(2),
  minRequests: integer("min_requests").notNull().default(10),
  webhookUrl: text("webhook_url").notNull(),
  secret: text("secret").notNull(),
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

export const schema = {
  resources,
  services,
  spans,
  traces,
  routeMinutes,
  classMinutes,
  slos,
  apiTokens,
  alertRules,
  alertState,
  alertEvents,
};
export type StorageSchema = typeof schema;
