import { createRequire } from "node:module";
import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { maybeFault, mirror, noteFailure } from "./guard.js";
import { sanitizeSql, sqlOperation } from "./sql.js";

// The architecture's `pg` mechanism: resolve `pg` with createRequire from inside the
// Nestrix package, then wrap Client.prototype.query and Pool.prototype.query. `pg` is
// CommonJS, so the module object (and its prototypes) is shared with the app's copy
// whenever both resolve to the same file.

type Fn = (this: unknown, ...args: unknown[]) => unknown;
interface PgLike {
  Client: { prototype: Record<string, unknown> };
  Pool: { prototype: Record<string, unknown> };
}

const WRAPPED = Symbol.for("nestrix.spike.pg.wrapped");
const tracer = () => trace.getTracer("nestrix-spike-pg");

export interface PgOptions {
  /**
   * When true (default), a query issued through Pool.prototype.query produces one
   * span: the pool's. The inner client.query that pg-pool makes is recognised by
   * the config object the pool wrapper hands it, and skipped.
   */
  dedupe?: boolean;
}

export interface PgResult {
  enabled: boolean;
  resolvedFrom?: string;
  version?: string;
  reason?: string;
}

/**
 * Config objects handed from the pool wrapper to pg-pool, so the client wrapper skips
 * the inner client.query. Reference-counted with one token per pool.query call: callers
 * may share one config object (a named prepared statement) across concurrent
 * pool.query calls. Tokens are interchangeable; the client side consumes any one, and a
 * pool call that completes without its inner client.query (connect error) removes its
 * own token if it is still there.
 */
const fromPool = new WeakMap<object, object[]>();

function markFromPool(config: object): object {
  const token = {};
  const list = fromPool.get(config);
  if (list) list.push(token);
  else fromPool.set(config, [token]);
  return token;
}

/** Called by the client wrapper: true if a pending pool call owns this config. */
function consumeFromPool(config: object): boolean {
  const list = fromPool.get(config);
  if (!list || list.length === 0) return false;
  list.shift();
  if (list.length === 0) fromPool.delete(config);
  return true;
}

function releaseFromPool(config: object, token: object): void {
  const list = fromPool.get(config);
  if (!list) return;
  const i = list.indexOf(token);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) fromPool.delete(config);
}

function textOf(config: unknown): unknown {
  if (typeof config === "string") return config;
  if (config && typeof config === "object" && "text" in config) {
    return (config as { text: unknown }).text;
  }
  return undefined;
}

function startSpan(
  via: string,
  config: unknown,
  target: Record<string, unknown> | undefined,
  label: string,
): Span {
  const text = textOf(config);
  return tracer().startSpan(
    `pg ${sqlOperation(text)}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system.name": "postgresql",
        "db.query.text": sanitizeSql(text),
        "db.operation.name": sqlOperation(text),
        "db.namespace": String(target?.database ?? ""),
        "server.address": String(target?.host ?? ""),
        "server.port": Number(target?.port ?? 0),
        "nestrix.pg.via": via,
        "nestrix.pg.module": label,
        "nestrix.pg.submittable":
          !!config &&
          typeof (config as { submit?: unknown }).submit === "function",
      },
    },
    context.active(),
  );
}

function endSpan(span: Span, error?: unknown): void {
  try {
    if (error !== undefined && error !== null) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    span.end();
  } catch {
    noteFailure("pg.end");
  }
}

function wrapCallback(span: Span, cb: Fn): Fn {
  return mirror(
    function (this: unknown, ...args: unknown[]) {
      endSpan(span, args[0]);
      return cb.apply(this, args);
    } as Fn,
    cb,
  );
}

/** Ends the span when the promise settles, returning a promise with the same outcome. */
function chain(span: Span, result: unknown): unknown {
  try {
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).then(
        (value) => {
          endSpan(span);
          return value;
        },
        (error) => {
          endSpan(span, error);
          throw error;
        },
      );
    }
  } catch {
    noteFailure("pg.chain");
  }
  return result;
}

/** pg-cursor / pg-query-stream: end on the protocol callbacks pg itself invokes. */
function watchSubmittable(span: Span, sub: Record<string, unknown>): void {
  let done = false;
  const finish = (error?: unknown) => {
    if (done) return;
    done = true;
    endSpan(span, error);
  };
  const ready = sub.handleReadyForQuery;
  const fail = sub.handleError;
  if (typeof ready === "function") {
    sub.handleReadyForQuery = mirror(
      function (this: unknown, ...a: unknown[]) {
        finish();
        return (ready as Fn).apply(this, a);
      } as Fn,
      ready as Fn,
    );
  }
  if (typeof fail === "function") {
    sub.handleError = mirror(
      function (this: unknown, ...a: unknown[]) {
        finish(a[0]);
        return (fail as Fn).apply(this, a);
      } as Fn,
      fail as Fn,
    );
  }
}

function wrapClientQuery(original: Fn, label: string): Fn {
  return mirror(
    function query(this: unknown, ...args: unknown[]) {
      let span: Span | undefined;
      let callArgs = args;
      let mode: "promise" | "callback" | "submittable" = "promise";
      // Decide inside the guard, call the original outside it: a throw from pg itself
      // must reach the caller once, not be mistaken for our failure and retried.
      let passThrough = false;
      try {
        maybeFault("pg.client.query");
        const [config, values, callback] = args;
        if (config == null) {
          passThrough = true; // pg throws its TypeError
        } else if (typeof config === "object" && consumeFromPool(config)) {
          passThrough = true; // issued by the wrapped Pool.prototype.query
        } else if (
          typeof (config as { callback?: unknown }).callback === "function" &&
          typeof values !== "function" &&
          typeof callback !== "function"
        ) {
          // `client.query({ text, callback })`: not traced in the spike (see result file).
          passThrough = true;
        }
      } catch {
        noteFailure("pg.client.query");
        passThrough = true;
      }
      if (passThrough) return original.apply(this, args);
      try {
        const [config, values, callback] = args;
        const target = this as Record<string, unknown>;
        span = startSpan("client", config, target, label);
        if (typeof (config as { submit?: unknown }).submit === "function") {
          mode = "submittable";
          watchSubmittable(span, config as Record<string, unknown>);
        } else if (typeof values === "function") {
          mode = "callback";
          callArgs = [
            config,
            wrapCallback(span, values as Fn),
            ...args.slice(2),
          ];
        } else if (typeof callback === "function") {
          mode = "callback";
          callArgs = [config, values, wrapCallback(span, callback as Fn)];
        }
      } catch {
        noteFailure("pg.client.query");
        if (span) endSpan(span);
        return original.apply(this, args);
      }
      let result: unknown;
      try {
        result = original.apply(this, callArgs);
      } catch (error) {
        endSpan(span, error);
        throw error;
      }
      return mode === "promise" ? chain(span, result) : result;
    } as Fn,
    original,
  );
}

function wrapPoolQuery(original: Fn, label: string, dedupe: boolean): Fn {
  return mirror(
    function query(this: unknown, ...args: unknown[]) {
      let span: Span | undefined;
      let callArgs = args;
      let mode: "promise" | "callback" = "promise";
      let marked: object | undefined;
      let token: object | undefined;
      if (typeof args[0] === "function" || args[0] == null) {
        return original.apply(this, args); // pg-pool reports these itself
      }
      try {
        maybeFault("pg.pool.query");
        const [text, values, cb] = args;
        const options = (this as { options?: Record<string, unknown> }).options;
        span = startSpan("pool", text, options, label);
        let passText: unknown = text;
        if (dedupe) {
          // pg normalises a string to `{ text }` itself, so this is equivalent.
          passText = typeof text === "string" ? { text } : text;
          if (passText && typeof passText === "object") {
            marked = passText;
            token = markFromPool(marked);
          }
        }
        const s = span;
        const unmark = () => {
          if (marked && token) releaseFromPool(marked, token);
        };
        if (typeof values === "function") {
          mode = "callback";
          callArgs = [
            passText,
            mirror(
              function (this: unknown, ...a: unknown[]) {
                unmark();
                endSpan(s, a[0]);
                return (values as Fn).apply(this, a);
              } as Fn,
              values as Fn,
            ),
          ];
        } else if (typeof cb === "function") {
          mode = "callback";
          callArgs = [
            passText,
            values,
            mirror(
              function (this: unknown, ...a: unknown[]) {
                unmark();
                endSpan(s, a[0]);
                return (cb as Fn).apply(this, a);
              } as Fn,
              cb as Fn,
            ),
          ];
        } else {
          callArgs = [passText, ...args.slice(1)];
        }
      } catch {
        noteFailure("pg.pool.query");
        if (span) endSpan(span);
        if (marked && token) releaseFromPool(marked, token);
        return original.apply(this, args);
      }
      let result: unknown;
      try {
        result = original.apply(this, callArgs);
      } catch (error) {
        if (marked && token) releaseFromPool(marked, token);
        endSpan(span, error);
        throw error;
      }
      if (mode === "promise") {
        const m = marked;
        const t = token;
        return chain(
          span,
          m &&
            t &&
            result &&
            typeof (result as Promise<unknown>).then === "function"
            ? (result as Promise<unknown>).finally(() => releaseFromPool(m, t))
            : result,
        );
      }
      return result;
    } as Fn,
    original,
  );
}

function wrapMethod(
  proto: Record<string, unknown>,
  name: string,
  make: (original: Fn) => Fn,
): boolean {
  const original = proto[name];
  if (typeof original !== "function") return false;
  if ((original as unknown as Record<symbol, unknown>)[WRAPPED]) return false;
  const wrapped = make(original as Fn);
  Object.defineProperty(wrapped, WRAPPED, { value: original });
  // Preserve the property's descriptor shape (writable/configurable/enumerable).
  const desc = Object.getOwnPropertyDescriptor(proto, name) ?? {
    writable: true,
    configurable: true,
    enumerable: false,
  };
  Object.defineProperty(proto, name, { ...desc, value: wrapped });
  return true;
}

/** Wraps a `pg` module object that the caller already holds. */
export function instrumentPgExports(
  pg: PgLike,
  label: string,
  options: PgOptions = {},
): boolean {
  const dedupe = options.dedupe ?? true;
  let any = false;
  try {
    any =
      wrapMethod(pg.Client.prototype, "query", (o) =>
        wrapClientQuery(o, label),
      ) || any;
    any =
      wrapMethod(pg.Pool.prototype, "query", (o) =>
        wrapPoolQuery(o, label, dedupe),
      ) || any;
  } catch {
    noteFailure("pg.instrument");
  }
  return any;
}

/**
 * The architecture's mechanism. `from` is the file to resolve from; by default this
 * module's own location (inside the Nestrix package).
 */
export function enablePg(
  options: PgOptions & { from?: string } = {},
): PgResult {
  try {
    const req = createRequire(options.from ?? import.meta.url);
    const resolved = req.resolve("pg");
    const pg = req("pg") as PgLike;
    let version: string | undefined;
    try {
      version = (req("pg/package.json") as { version?: string }).version;
    } catch {
      // pg's exports map may not expose package.json
    }
    instrumentPgExports(pg, `pg@${version ?? "?"}`, options);
    return { enabled: true, resolvedFrom: resolved, version };
  } catch (error) {
    return {
      enabled: false,
      reason:
        (error as { code?: string }).code ??
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Unwraps everything wrapped through `pg` (tests only). */
export function disablePgExports(pg: PgLike): void {
  for (const proto of [pg.Client.prototype, pg.Pool.prototype]) {
    const current = proto.query as unknown as Record<symbol, unknown>;
    const original = current?.[WRAPPED];
    if (original) {
      const desc = Object.getOwnPropertyDescriptor(proto, "query");
      Object.defineProperty(proto, "query", { ...desc, value: original });
    }
  }
}
