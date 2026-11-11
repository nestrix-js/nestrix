/**
 * `pg` query spans (architecture §4.4, D-50, D-59; reference: `spikes/p0-s2/src/nestrix/pg.ts`).
 *
 * Mechanism: wrap `Client.prototype.query` and `Pool.prototype.query` of
 * - the `pg` that `createRequire` from this package reaches (the optional peer), loaded here if
 *   the app has not loaded it yet, and
 * - every `…/node_modules/pg/lib/index.js` already in the module cache (nested copies, such as
 *   the one MikroORM pins), at enable and again at `onApplicationBootstrap` (D-50). ESM imports of
 *   `pg` load that same CommonJS file, so they are in the cache too. A copy loaded after the last
 *   scan stays untraced.
 * Wrapping is idempotent per prototype and permanent: a wrapper passes straight through while no
 * installation is active, so turning the integration off never needs to unwrap a prototype that
 * something else may have wrapped on top.
 *
 * Span timing (D-59): a span covers the query, not pool wait. `pool.query()` does not open a
 * span; it records the caller's context in a token keyed by the config object it hands pg-pool
 * (a string becomes `{ text }`, which pg does itself). pg-pool then calls `client.query()` on a
 * pooled client, possibly from another caller's async context (it serves queued callers from a
 * connection release), and the client wrapper opens the span under the token's context. Tokens
 * are reference-counted per config object, first in first out, so concurrent `pool.query` calls
 * sharing one config object (a named prepared statement) each keep theirs. Only a pooled client
 * (one pg-pool gave a `release` function) consumes a token. A pool call that fails before its
 * query reaches a client (connection refused, pool closed, connection timeout) gets a span from
 * the pool call's start to the failure, with the error, so a database outage is visible.
 *
 * Forms: promise, callback (`(config, cb)` and `(config, values, cb)`), and submittables
 * (`pg-cursor`, `pg-query-stream`, `pg.Query`), whose spans end through the protocol callbacks pg
 * itself invokes (`handleReadyForQuery`, `handleError`); no `'error'` listener is ever added.
 * `client.query({ text, callback })` (callback inside the config) is passed through untraced, as in
 * the spike: a pg version whose `normalizeQueryConfig` does not clone the config first writes the
 * callback back onto the caller's object, so wrapping it there would chain wrappers on every reuse
 * of that object (8.23.1 clones it; older 8.x versions were not checked).
 *
 * Every wrapper decides inside a guard and calls the original exactly once, outside it (§4.2).
 */
import { createRequire } from "node:module";
import { type Context, context, type Span } from "@opentelemetry/api";
import type { Diagnostics } from "../diagnostics.js";
import {
  type DbCall,
  endDbSpan,
  fault,
  isSuppressed,
  startDbSpan,
  toPort,
  toText,
} from "./db-span.js";
import { sanitizeSql, sqlOperation, sqlTarget } from "./sql.js";

type Fn = (this: unknown, ...args: unknown[]) => unknown;

interface PgModuleLike {
  readonly Client?: { readonly prototype?: Record<string, unknown> };
  readonly Pool?: { readonly prototype?: Record<string, unknown> };
}

/** Marks a wrapper; its value is the original function. Process-wide, across Nestrix copies. */
const WRAPPED = Symbol.for("nestrix.pg.wrapped");

/** Matches the main file of any `pg` copy in the module cache. */
const PG_INDEX = /[\\/]node_modules[\\/]pg[\\/]lib[\\/]index\.js$/;

/** Where a `pg` module was found and when it was first wrapped. */
export interface PgModuleRecord {
  readonly path: string;
  readonly phase: PgScanPhase;
}

export type PgScanPhase = "enable" | "bootstrap";

export interface PgStatus {
  /** `true` once at least one `pg` module is wrapped. */
  readonly enabled: boolean;
  /** Why the `pg` this package resolves was not wrapped (`MODULE_NOT_FOUND`), when it was not. */
  readonly reason: string | undefined;
  /** The file `createRequire` resolved `pg` to, when it did. */
  readonly resolved: string | undefined;
  readonly modules: readonly PgModuleRecord[];
}

let references = 0;
let diagnostics: Diagnostics | undefined;
let resolveReason: string | undefined;
let resolvedPath: string | undefined;
const modules = new Map<string, PgModuleRecord>();
/** Exports objects already handled, so a scan skips them cheaply. */
const seen = new WeakSet<object>();

function countFailure(where: string, error: unknown): void {
  diagnostics?.countFailure(where, error);
}

// ---------------------------------------------------------------------------------------------
// Pool → client tokens (D-59)
// ---------------------------------------------------------------------------------------------

interface Token {
  readonly parent: Context;
  /** Epoch milliseconds of the `pool.query()` call, for a span of a call that never reached a client. */
  readonly startedAt: number;
  consumed: boolean;
}

const tokens = new WeakMap<object, Token[]>();

function pushToken(config: object, token: Token): void {
  const list = tokens.get(config);
  if (list === undefined) tokens.set(config, [token]);
  else list.push(token);
}

function takeToken(config: object): Token | undefined {
  const list = tokens.get(config);
  if (list === undefined) return undefined;
  const token = list.shift();
  if (list.length === 0) tokens.delete(config);
  if (token !== undefined) token.consumed = true;
  return token;
}

function dropToken(config: object, token: Token): void {
  const list = tokens.get(config);
  if (list === undefined) return;
  const i = list.indexOf(token);
  if (i !== -1) list.splice(i, 1);
  if (list.length === 0) tokens.delete(config);
}

// ---------------------------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------------------------

function textOf(config: unknown): unknown {
  if (typeof config === "string") return config;
  if (config !== null && typeof config === "object") {
    const text = (config as { text?: unknown }).text;
    if (text !== undefined) return text;
    // pg-query-stream keeps its statement on its cursor.
    const cursor = (config as { cursor?: { text?: unknown } }).cursor;
    if (cursor !== null && typeof cursor === "object") return cursor.text;
  }
  return undefined;
}

function pgCall(config: unknown, target: unknown): DbCall {
  const text = sanitizeSql(textOf(config), "postgresql");
  const operation = sqlOperation(text);
  const t = (target ?? {}) as Record<string, unknown>;
  return {
    system: "postgresql",
    text,
    operation,
    target: sqlTarget(text, operation),
    namespace: toText(t.database),
    address: toText(t.host),
    port: toPort(t.port),
  };
}

function nowMillis(): number {
  return performance.timeOrigin + performance.now();
}

// ---------------------------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------------------------

function endOnce(state: { span: Span; ended: boolean }, error?: unknown): void {
  try {
    fault("pg.end");
    if (state.ended) return;
    state.ended = true;
    endDbSpan(state.span, error);
  } catch (e) {
    countFailure("integrations.pg.end", e);
  }
}

/** Copies `name` and `length`, so the wrapper looks like what it replaces. */
function mirror<F extends Fn>(wrapper: F, original: Fn): F {
  try {
    Object.defineProperty(wrapper, "name", { value: original.name });
    Object.defineProperty(wrapper, "length", { value: original.length });
  } catch (error) {
    countFailure("integrations.pg.mirror", error);
  }
  return wrapper;
}

/**
 * A callback that settles first (guarded), then calls `cb` with the same `this` and arguments,
 * inside `caller` (the OpenTelemetry context of the `query()` call). pg invokes callbacks from the
 * connection's socket events, so without this a query issued inside a callback would lose its
 * parent; upstream's pg instrumentation binds callbacks the same way. Only the OpenTelemetry
 * context changes.
 */
function settleThen(
  settle: (error: unknown) => void,
  cb: Fn,
  caller: Context,
): Fn {
  return mirror(
    function (this: unknown, ...args: unknown[]) {
      settle(args[0]);
      return context.with(caller, cb, this, ...args);
    } as Fn,
    cb,
  );
}

/**
 * Follows a promise: returns one with the same outcome that settles first. The caller holds the
 * derived promise, so an unawaited rejection is still reported as unhandled, once.
 */
function follow(result: unknown, settle: (error: unknown) => void): unknown {
  try {
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      return (result as Promise<unknown>).then(
        (value) => {
          settle(undefined);
          return value;
        },
        (error: unknown) => {
          settle(error ?? new Error("pg query rejected"));
          throw error;
        },
      );
    }
    settle(undefined);
  } catch (error) {
    countFailure("integrations.pg.follow", error);
  }
  return result;
}

/** pg-cursor, pg-query-stream, pg.Query: end on the protocol callbacks pg invokes. */
function watchSubmittable(
  state: { span: Span; ended: boolean },
  sub: Record<string, unknown>,
): void {
  for (const [name, isError] of [
    ["handleReadyForQuery", false],
    ["handleError", true],
  ] as const) {
    const original = sub[name];
    if (typeof original !== "function") continue;
    sub[name] = mirror(
      function (this: unknown, ...args: unknown[]) {
        endOnce(
          state,
          isError ? (args[0] ?? new Error("pg query failed")) : undefined,
        );
        return (original as Fn).apply(this, args);
      } as Fn,
      original as Fn,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Client.prototype.query
// ---------------------------------------------------------------------------------------------

interface Plan {
  readonly args: unknown[];
  readonly promise: boolean;
  readonly settle: (error: unknown) => void;
}

function planClientQuery(client: unknown, args: unknown[]): Plan | undefined {
  if (references === 0) return undefined;
  const [config, values, callback] = args;
  if (config === null || config === undefined) return undefined; // pg throws its TypeError
  let token: Token | undefined;
  if (
    typeof config === "object" &&
    typeof (client as { release?: unknown } | null)?.release === "function"
  ) {
    token = takeToken(config);
  }
  const submittable =
    typeof (config as { submit?: unknown }).submit === "function";
  if (
    token === undefined &&
    !submittable &&
    typeof (config as { callback?: unknown }).callback === "function" &&
    typeof values !== "function" &&
    typeof callback !== "function"
  ) {
    return undefined; // `{ text, callback }`: untraced (module comment)
  }
  const parent = token?.parent ?? context.active();
  if (isSuppressed(parent)) return undefined;
  // pg-pool's own callback (token present) keeps pg-pool's context; the pool wrapper binds the
  // caller's callback.
  const caller = token === undefined ? parent : context.active();
  const span = startDbSpan(pgCall(config, client), parent);
  const state = { span, ended: false };
  const settle = (error: unknown) => endOnce(state, error);
  try {
    if (submittable) {
      watchSubmittable(state, config as Record<string, unknown>);
      return { args, promise: false, settle };
    }
    if (typeof values === "function") {
      return {
        args: [
          config,
          settleThen(settle, values as Fn, caller),
          ...args.slice(2),
        ],
        promise: false,
        settle,
      };
    }
    if (typeof callback === "function") {
      return {
        args: [
          config,
          values,
          settleThen(settle, callback as Fn, caller),
          ...args.slice(3),
        ],
        promise: false,
        settle,
      };
    }
    return { args, promise: true, settle };
  } catch (error) {
    endOnce(state);
    throw error;
  }
}

function wrapClientQuery(original: Fn): Fn {
  return mirror(
    function query(this: unknown, ...args: unknown[]) {
      let plan: Plan | undefined;
      try {
        fault("pg.client.query");
        plan = planClientQuery(this, args);
      } catch (error) {
        countFailure("integrations.pg.client.query", error);
        plan = undefined;
      }
      if (plan === undefined) return original.apply(this, args);
      let result: unknown;
      try {
        result = original.apply(this, plan.args);
      } catch (error) {
        plan.settle(error);
        throw error;
      }
      return plan.promise ? follow(result, plan.settle) : result;
    } as Fn,
    original,
  );
}

// ---------------------------------------------------------------------------------------------
// Pool.prototype.query
// ---------------------------------------------------------------------------------------------

function planPoolQuery(pool: unknown, args: unknown[]): Plan | undefined {
  if (references === 0) return undefined;
  const [text, values, callback] = args;
  if (text === null || text === undefined || typeof text === "function")
    return undefined; // pg-pool reports these itself
  const config: unknown = typeof text === "string" ? { text } : text;
  if (typeof config !== "object" || config === null) return undefined;
  const token: Token = {
    parent: context.active(),
    startedAt: nowMillis(),
    consumed: false,
  };
  pushToken(config, token);
  let settled = false;
  const settle = (error: unknown): void => {
    try {
      fault("pg.pool.settle");
      if (settled) return;
      settled = true;
      if (token.consumed) return;
      dropToken(config, token);
      // Failed before the query reached a client: a span for the attempt, with the error.
      if (error === undefined || error === null || isSuppressed(token.parent))
        return;
      const options = (pool as { options?: unknown } | null)?.options;
      const span = startDbSpan(
        pgCall(config, options),
        token.parent,
        token.startedAt,
      );
      endDbSpan(span, error);
    } catch (e) {
      countFailure("integrations.pg.pool.settle", e);
    }
  };
  try {
    if (typeof values === "function") {
      return {
        args: [config, settleThen(settle, values as Fn, token.parent)],
        promise: false,
        settle,
      };
    }
    if (typeof callback === "function") {
      return {
        args: [
          config,
          values,
          settleThen(settle, callback as Fn, token.parent),
        ],
        promise: false,
        settle,
      };
    }
    return { args: [config, ...args.slice(1)], promise: true, settle };
  } catch (error) {
    dropToken(config, token);
    throw error;
  }
}

function wrapPoolQuery(original: Fn): Fn {
  return mirror(
    function query(this: unknown, ...args: unknown[]) {
      let plan: Plan | undefined;
      try {
        fault("pg.pool.query");
        plan = planPoolQuery(this, args);
      } catch (error) {
        countFailure("integrations.pg.pool.query", error);
        plan = undefined;
      }
      if (plan === undefined) return original.apply(this, args);
      let result: unknown;
      try {
        result = original.apply(this, plan.args);
      } catch (error) {
        plan.settle(error);
        throw error;
      }
      return plan.promise ? follow(result, plan.settle) : result;
    } as Fn,
    original,
  );
}

// ---------------------------------------------------------------------------------------------
// Wrapping modules
// ---------------------------------------------------------------------------------------------

function wrapMethod(
  proto: Record<string, unknown> | undefined,
  make: (original: Fn) => Fn,
): boolean {
  if (proto === undefined || proto === null) return false;
  const original = proto.query;
  if (typeof original !== "function") return false;
  if ((original as unknown as Record<symbol, unknown>)[WRAPPED] !== undefined)
    return false;
  const wrapped = make(original as Fn);
  Object.defineProperty(wrapped, WRAPPED, { value: original });
  const own = Object.getOwnPropertyDescriptor(proto, "query");
  Object.defineProperty(proto, "query", {
    configurable: own?.configurable ?? true,
    enumerable: own?.enumerable ?? false,
    writable: own?.writable ?? true,
    value: wrapped,
  });
  return true;
}

/**
 * Wraps one `pg` module's prototypes. Reads `Client` and `Pool` only: pg's exports also carry a
 * lazy `native` getter that would try to load `pg-native`.
 */
function wrapModule(pg: PgModuleLike, path: string, phase: PgScanPhase): void {
  if (seen.has(pg)) return;
  const client = pg.Client?.prototype;
  const pool = pg.Pool?.prototype;
  if (typeof client?.query !== "function" || typeof pool?.query !== "function")
    return;
  seen.add(pg);
  wrapMethod(client, wrapClientQuery);
  wrapMethod(pool, wrapPoolQuery);
  if (!modules.has(path)) modules.set(path, { path, phase });
}

function scanCache(require: NodeJS.Require, phase: PgScanPhase): void {
  const cache = require.cache;
  for (const path of Object.keys(cache)) {
    if (!PG_INDEX.test(path)) continue;
    try {
      const entry = cache[path];
      // A copy still loading (a require cycle) has partial exports; the next scan sees it.
      if (entry === undefined || !entry.loaded) continue;
      const exports = entry.exports as PgModuleLike | null;
      if (exports !== null && typeof exports === "object")
        wrapModule(exports, path, phase);
    } catch (error) {
      countFailure("integrations.pg.scan", error);
    }
  }
}

let requireFrom: NodeJS.Require | undefined;

/** Internal options for tests. */
export interface PgInternals {
  /** Resolve `pg` from this file URL or path instead of this module (tests: an absent `pg`). */
  readonly resolveFrom?: string;
}

/**
 * Activates the integration: wraps the resolvable `pg` and the copies in the module cache.
 * Returns an idempotent disposer. Reference-counted, so a second Nestrix application in the
 * process keeps it active until both close.
 */
export function enablePg(
  diag: Diagnostics,
  internals: PgInternals = {},
): () => void {
  references++;
  if (references === 1) {
    diagnostics = diag;
    try {
      requireFrom = createRequire(internals.resolveFrom ?? import.meta.url);
      try {
        resolvedPath = requireFrom.resolve("pg");
        const pg = requireFrom("pg") as PgModuleLike;
        resolveReason = undefined;
        wrapModule(pg, resolvedPath, "enable");
      } catch (error) {
        resolvedPath = undefined;
        resolveReason =
          (error as { code?: unknown } | null)?.code === "MODULE_NOT_FOUND"
            ? "MODULE_NOT_FOUND"
            : String((error as { message?: unknown } | null)?.message ?? error);
      }
      scanCache(requireFrom, "enable");
    } catch (error) {
      countFailure("integrations.pg.enable", error);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    references = Math.max(0, references - 1);
  };
}

/** Scans the module cache again (`onApplicationBootstrap`, D-50). Does nothing while inactive. */
export function rescanPg(phase: PgScanPhase = "bootstrap"): void {
  try {
    if (references === 0 || requireFrom === undefined) return;
    scanCache(requireFrom, phase);
  } catch (error) {
    countFailure("integrations.pg.rescan", error);
  }
}

/** Internal: what was found and wrapped, for tests and diagnostics. */
export function pgStatus(): PgStatus {
  return {
    enabled: modules.size > 0,
    reason: resolveReason,
    resolved: resolvedPath,
    modules: [...modules.values()],
  };
}

/** Internal, for tests: whether the integration is active (installed and not disposed). */
export function pgActive(): boolean {
  return references > 0;
}
