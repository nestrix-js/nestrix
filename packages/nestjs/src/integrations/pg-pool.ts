/**
 * `pg` pool wait (issue #38, D-98): how long `pool.connect()` took to hand out a client.
 *
 * D-59 stands: a query span covers the query only. The wait is measured separately, by wrapping
 * `Pool.prototype.connect` of every `pg` copy the query wrappers reach (pg.ts). pg-pool's own
 * `pool.query()` goes through `this.connect(cb)`, so one wrapper covers both `pool.query()` and an
 * explicit `pool.connect()` (one transaction per request).
 *
 * - Metrics (OpenTelemetry semantic conventions, incubating, checked against
 *   `@opentelemetry/semantic-conventions` 1.45.0; the names are string literals here because the
 *   incubating entry point is not loaded at runtime):
 *   `db.client.connection.wait_time` (histogram, seconds), recorded for every acquisition that
 *   succeeded; `db.client.connection.count` with `db.client.connection.state` `idle` or `used`, and
 *   `db.client.connection.pending_requests` (observable up-down counters, read from pg-pool's
 *   `idleCount`, `totalCount` and `waitingCount` at collection time). Every point carries
 *   `db.client.connection.pool.name`. Recorded through `@opentelemetry/api`'s global
 *   `MeterProvider`, rebinding when it changes (as metrics/binding.ts does); nothing while it is the
 *   no-op one, nothing when `metrics: false`.
 * - Trace: an acquisition that found no free client (`idleCount > waitingCount` at the call) and
 *   succeeded after waiting at least `poolWaitThresholdMillis` (default 5) adds an `INTERNAL` span `pg.pool.connect` from the call to the hand-out, under the caller's
 *   context, only inside a trace. It carries no `db.system.name`, so the dashboard does not count it
 *   as a query. A failed acquisition adds nothing: `pool.query()` keeps its existing failure span.
 *
 * Pool name: `host:port/database` from the first client the pool hands out (pg's resolved
 * connection parameters, which never include the user or password), IPv6 hosts in brackets. Pools
 * with the same name are summed. A pool that never handed out a client reports no counts.
 *
 * The wrapper changes nothing observable: it calls the original once, with the same arguments,
 * except that a callback is replaced by one that measures first and then calls it with the same
 * `this` and arguments (no OpenTelemetry context change), and a returned promise is followed by a
 * derived promise with the same outcome. Every Nestrix body is guarded (AGENTS.md rule 1).
 * Imports `@opentelemetry/api` only (rule 5).
 */
import {
  type Attributes,
  context,
  createNoopMeter,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
  type ObservableResult,
  type ObservableUpDownCounter,
  SpanKind,
  trace,
} from "@opentelemetry/api";
import type { Diagnostics } from "../diagnostics.js";
import { TRACER_NAME } from "../outbound/rules.js";
import { endNestrixSpan, startNestrixSpan } from "../trace-limit.js";
import {
  fault,
  hasActiveSpan,
  isSuppressed,
  toPort,
  toText,
} from "./db-span.js";

type Fn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * The meter name, the same as metrics/binding.ts's `METER_NAME` and the tracer's. Not imported
 * from there: this file is loaded by pg's integration, and binding.ts pulls in the runtime
 * metrics.
 */
const METER_NAME = TRACER_NAME;

let noopMeterPrototype: object | null | undefined;

/** Whether `meter` is the API's no-op meter (as metrics/binding.ts `isNoopMeter`). */
function isNoopMeter(meter: unknown): boolean {
  if (meter === null || typeof meter !== "object") return true;
  noopMeterPrototype ??= Object.getPrototypeOf(createNoopMeter()) as object;
  return Object.getPrototypeOf(meter) === noopMeterPrototype;
}

/** Semantic-convention names (incubating; 1.45.0). */
export const METRIC_DB_CLIENT_CONNECTION_WAIT_TIME =
  "db.client.connection.wait_time";
export const METRIC_DB_CLIENT_CONNECTION_COUNT = "db.client.connection.count";
export const METRIC_DB_CLIENT_CONNECTION_PENDING_REQUESTS =
  "db.client.connection.pending_requests";
export const ATTR_DB_CLIENT_CONNECTION_POOL_NAME =
  "db.client.connection.pool.name";
export const ATTR_DB_CLIENT_CONNECTION_STATE = "db.client.connection.state";

/** The span for a wait at or above the threshold. */
export const PG_POOL_CONNECT_SPAN = "pg.pool.connect";

/** Default `integrations.pg.poolWaitThresholdMillis`. */
export const DEFAULT_POOL_WAIT_THRESHOLD_MILLIS = 5;

/**
 * Histogram buckets in seconds. Pool waits are bimodal: sub-millisecond with a free client, then
 * from a few milliseconds (a new connection) to the connection timeout under exhaustion.
 */
export const POOL_WAIT_BUCKETS: readonly number[] = Object.freeze([
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

/** Pools tracked for the count gauges; past this, new pools are not tracked (counted once). */
const MAX_TRACKED_POOLS = 256;

export interface PgPoolConfig {
  /** Span threshold in milliseconds, or `false` for no spans. */
  readonly waitThresholdMillis: number | false;
  /** Whether to record the metrics (`metrics` option not `false`). */
  readonly metrics: boolean;
}

interface PoolLike {
  readonly idleCount?: unknown;
  readonly totalCount?: unknown;
  readonly waitingCount?: unknown;
  readonly ended?: unknown;
  readonly options?: unknown;
}

let config: PgPoolConfig | undefined;
let diagnostics: Diagnostics | undefined;

function countFailure(where: string, error: unknown): void {
  try {
    diagnostics?.countFailure(where, error);
  } catch {
    // Diagnostics never throw; this is belt and braces on the request path.
  }
}

/** Sets the configuration (first installation wins) or clears it (`undefined`). Never throws. */
export function configurePgPool(
  next: PgPoolConfig | undefined,
  diag?: Diagnostics,
): void {
  config = next;
  if (diag !== undefined) diagnostics = diag;
  if (next === undefined) unbind();
}

// ---------------------------------------------------------------------------------------------
// Pool names and tracking
// ---------------------------------------------------------------------------------------------

const names = new WeakMap<object, string>();
const trackedSet = new WeakSet<object>();
const tracked = new Set<WeakRef<object>>();
let trackFull = false;

/** `host:port/database`, from a client's resolved parameters (never user or password). */
export function poolName(source: unknown): string | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const s = source as Record<string, unknown>;
  const params =
    s.connectionParameters !== null &&
    typeof s.connectionParameters === "object"
      ? (s.connectionParameters as Record<string, unknown>)
      : s;
  let host = toText(params.host);
  const port = toPort(params.port);
  const database = toText(params.database);
  if (host === undefined || host === "") return undefined;
  // IPv6 in brackets; a Unix socket path (Cloud SQL: `/cloudsql/proj:region:inst`) as it is.
  if (host.includes(":") && !host.startsWith("[") && !host.startsWith("/"))
    host = `[${host}]`;
  return `${host}${port === undefined ? "" : `:${port}`}${
    database === undefined || database === "" ? "" : `/${database}`
  }`;
}

function nameFor(pool: object, client: unknown): string {
  let name = names.get(pool);
  if (name === undefined) {
    name =
      poolName(client) ?? poolName((pool as PoolLike).options) ?? "postgresql";
    names.set(pool, name);
  }
  return name;
}

/** Tracks `pool`; `false` past the cap, so its waits are not recorded either (bounded series). */
function track(pool: object): boolean {
  if (trackedSet.has(pool)) return true;
  if (tracked.size >= MAX_TRACKED_POOLS) {
    sweep();
    if (tracked.size >= MAX_TRACKED_POOLS) {
      if (!trackFull) {
        trackFull = true;
        countFailure(
          "integrations.pg.pool.track",
          new Error(
            `more than ${MAX_TRACKED_POOLS} pg pools; counts omit the rest`,
          ),
        );
      }
      return false;
    }
  }
  trackedSet.add(pool);
  tracked.add(new WeakRef(pool));
  return true;
}

/**
 * Whether this call will be served by an idle client: more idle clients than callers already
 * queued. pg-pool still hands an idle client out on `process.nextTick`, so synchronous work after
 * `connect()` would otherwise count as a wait (D-98). Read from pg-pool's public getters.
 */
function hasFreeClient(pool: object): boolean {
  try {
    const p = pool as PoolLike;
    return count(p.idleCount) > count(p.waitingCount);
  } catch (error) {
    countFailure("integrations.pg.pool.free", error);
    return false;
  }
}

function sweep(): void {
  for (const ref of tracked) {
    const pool = ref.deref() as PoolLike | undefined;
    if (pool === undefined || pool.ended === true) {
      tracked.delete(ref);
      if (pool !== undefined) trackedSet.delete(pool);
    }
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** Internal, for tests: forget every tracked pool. */
export function resetPgPoolsForTests(): void {
  reportedCount.clear();
  reportedPending.clear();
  for (const ref of tracked) {
    const pool = ref.deref();
    if (pool !== undefined) trackedSet.delete(pool);
  }
  tracked.clear();
  trackFull = false;
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

const UNBOUND = Symbol("unbound");
let boundProvider: MeterProvider | typeof UNBOUND = UNBOUND;
let histogram: Histogram | undefined;
let observables:
  | { count: ObservableUpDownCounter; pending: ObservableUpDownCounter }
  | undefined;

type Totals = Map<string, { idle: number; used: number; pending: number }>;

/**
 * Totals with a zero entry for each name reported last time and gone now (its pools ended or were
 * collected), once: the SDK's cumulative storage keeps exporting an attribute set's last value
 * after a callback stops observing it (sdk-metrics 3.1.1, checked), so a gone pool would
 * otherwise show its last counts for ever.
 */
function withGone(reported: Set<string>): Totals {
  const live = totals();
  const out: Totals = new Map(live);
  for (const name of reported)
    if (!live.has(name)) out.set(name, { idle: 0, used: 0, pending: 0 });
  reported.clear();
  for (const name of live.keys()) reported.add(name);
  return out;
}

const reportedCount = new Set<string>();
const reportedPending = new Set<string>();

function observeCount(result: ObservableResult): void {
  try {
    fault("pg.pool.observe");
    for (const [name, t] of withGone(reportedCount)) {
      result.observe(t.idle, {
        [ATTR_DB_CLIENT_CONNECTION_POOL_NAME]: name,
        [ATTR_DB_CLIENT_CONNECTION_STATE]: "idle",
      });
      result.observe(t.used, {
        [ATTR_DB_CLIENT_CONNECTION_POOL_NAME]: name,
        [ATTR_DB_CLIENT_CONNECTION_STATE]: "used",
      });
    }
  } catch (error) {
    countFailure("integrations.pg.pool.observe", error);
  }
}

function observePending(result: ObservableResult): void {
  try {
    fault("pg.pool.observe");
    for (const [name, t] of withGone(reportedPending)) {
      result.observe(t.pending, {
        [ATTR_DB_CLIENT_CONNECTION_POOL_NAME]: name,
      });
    }
  } catch (error) {
    countFailure("integrations.pg.pool.observe", error);
  }
}

function totals(): Totals {
  sweep();
  const out: Totals = new Map();
  for (const ref of tracked) {
    const pool = ref.deref() as PoolLike | undefined;
    if (pool === undefined) continue;
    const name = names.get(pool);
    if (name === undefined) continue; // never handed out a client
    const idle = count(pool.idleCount);
    const total = count(pool.totalCount);
    const entry = out.get(name) ?? { idle: 0, used: 0, pending: 0 };
    entry.idle += idle;
    entry.used += Math.max(0, total - idle);
    entry.pending += count(pool.waitingCount);
    out.set(name, entry);
  }
  return out;
}

function unbind(): void {
  histogram = undefined;
  boundProvider = UNBOUND;
  const o = observables;
  observables = undefined;
  try {
    o?.count.removeCallback(observeCount);
    o?.pending.removeCallback(observePending);
  } catch (error) {
    countFailure("integrations.pg.pool.unbind", error);
  }
}

/** The histogram on the current global provider, rebinding when it changed. Never throws. */
function waitHistogram(): Histogram | undefined {
  try {
    if (config?.metrics !== true) return undefined;
    const provider = metrics.getMeterProvider();
    if (provider === boundProvider) return histogram;
    unbind();
    // Remembered first: a provider that throws below is not retried on every call.
    boundProvider = provider;
    const meter: Meter = provider.getMeter(METER_NAME);
    if (isNoopMeter(meter)) return undefined;
    histogram = meter.createHistogram(METRIC_DB_CLIENT_CONNECTION_WAIT_TIME, {
      description:
        "The time it took to obtain an open connection from the pool.",
      unit: "s",
      advice: { explicitBucketBoundaries: [...POOL_WAIT_BUCKETS] },
    });
    const countInstrument = meter.createObservableUpDownCounter(
      METRIC_DB_CLIENT_CONNECTION_COUNT,
      {
        description:
          "The number of connections that are currently in the state described by the state attribute.",
        unit: "{connection}",
      },
    );
    const pending = meter.createObservableUpDownCounter(
      METRIC_DB_CLIENT_CONNECTION_PENDING_REQUESTS,
      {
        description:
          "The number of current pending requests for an open connection.",
        unit: "{request}",
      },
    );
    countInstrument.addCallback(observeCount);
    pending.addCallback(observePending);
    observables = { count: countInstrument, pending };
    return histogram;
  } catch (error) {
    countFailure("integrations.pg.pool.bind", error);
    return histogram;
  }
}

// ---------------------------------------------------------------------------------------------
// Pool.prototype.connect
// ---------------------------------------------------------------------------------------------

interface ConnectPlan {
  readonly args: unknown[];
  readonly promise: boolean;
  readonly settle: (error: unknown, client: unknown) => void;
}

function planConnect(pool: unknown, args: unknown[]): ConnectPlan | undefined {
  const c = config;
  if (c === undefined) return undefined;
  if (!c.metrics && c.waitThresholdMillis === false) return undefined;
  if (pool === null || typeof pool !== "object") return undefined;
  const startedAt = performance.now();
  const parent = context.active();
  const free = hasFreeClient(pool);
  let record = false;
  if (c.metrics) {
    record = track(pool);
    waitHistogram(); // binds the count instruments on first use
  }
  let settled = false;
  const settle = (error: unknown, client: unknown): void => {
    try {
      fault("pg.pool.connect.settle");
      if (settled) return;
      settled = true;
      if (error !== undefined && error !== null) return; // failure: nothing added
      const endedAt = performance.now();
      const waitMillis = endedAt - startedAt;
      const name = nameFor(pool, client);
      const attributes: Attributes = {
        [ATTR_DB_CLIENT_CONNECTION_POOL_NAME]: name,
      };
      if (record) waitHistogram()?.record(waitMillis / 1000, attributes);
      const threshold = c.waitThresholdMillis;
      if (
        !free &&
        threshold !== false &&
        waitMillis >= threshold &&
        hasActiveSpan(parent) &&
        !isSuppressed(parent)
      ) {
        const origin = performance.timeOrigin;
        const span = startNestrixSpan(
          trace.getTracer(TRACER_NAME),
          PG_POOL_CONNECT_SPAN,
          {
            kind: SpanKind.INTERNAL,
            attributes,
            startTime: origin + startedAt,
          },
          parent,
        );
        endNestrixSpan(span, origin + endedAt);
      }
    } catch (e) {
      countFailure("integrations.pg.pool.connect.settle", e);
    }
  };
  const [cb] = args;
  if (typeof cb === "function") {
    const original = cb as Fn;
    const wrapped = function (this: unknown, ...cbArgs: unknown[]) {
      settle(cbArgs[0], cbArgs[1]);
      return original.apply(this, cbArgs);
    } as Fn;
    copyShape(wrapped, original);
    return { args: [wrapped, ...args.slice(1)], promise: false, settle };
  }
  return { args, promise: true, settle };
}

function copyShape(wrapper: Fn, original: Fn): void {
  try {
    Object.defineProperty(wrapper, "name", { value: original.name });
    Object.defineProperty(wrapper, "length", { value: original.length });
  } catch (error) {
    countFailure("integrations.pg.mirror", error);
  }
}

function followConnect(
  result: unknown,
  settle: (error: unknown, client: unknown) => void,
): unknown {
  try {
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      return (result as Promise<unknown>).then(
        (client) => {
          settle(undefined, client);
          return client;
        },
        (error: unknown) => {
          settle(error ?? new Error("pg pool connect rejected"), undefined);
          throw error;
        },
      );
    }
  } catch (error) {
    countFailure("integrations.pg.pool.connect.follow", error);
  }
  return result;
}

/**
 * Wraps `Pool.prototype.connect`. `isActive` says whether an installation is active; while none
 * is, the wrapper passes straight through (wrapping is permanent, as in pg.ts).
 */
export function wrapPoolConnect(original: Fn, isActive: () => boolean): Fn {
  const wrapper = function connect(this: unknown, ...args: unknown[]) {
    let plan: ConnectPlan | undefined;
    try {
      fault("pg.pool.connect");
      plan = isActive() ? planConnect(this, args) : undefined;
    } catch (error) {
      countFailure("integrations.pg.pool.connect", error);
      plan = undefined;
    }
    if (plan === undefined) return original.apply(this, args);
    let result: unknown;
    try {
      result = original.apply(this, plan.args);
    } catch (error) {
      plan.settle(error, undefined);
      throw error;
    }
    return plan.promise ? followConnect(result, plan.settle) : result;
  } as Fn;
  copyShape(wrapper, original);
  return wrapper;
}
