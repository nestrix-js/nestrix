import type { AsyncLocalStorage } from "node:async_hooks";
import dc from "node:diagnostics_channel";
import {
  type Attributes,
  type Context,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { maybeFault, noteFailure } from "./guard.js";
import { sanitizeSql, sqlOperation } from "./sql.js";

// Subscribers for libraries that publish their own TracingChannels (mysql2 3.20+,
// ioredis 5.11+). The span starts in `start`, which the library publishes
// synchronously in whatever async context the publishing call runs in.

type Ctx = Record<string, unknown> & { error?: unknown };

interface Mapping {
  name: (ctx: Ctx) => string;
  attributes: (ctx: Ctx) => Attributes;
}

const spans = new WeakMap<object, Span>();

function finish(ctx: Ctx, how: string): void {
  const span = spans.get(ctx);
  if (!span) return;
  spans.delete(ctx);
  if (ctx.error !== undefined) {
    span.recordException(ctx.error as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message:
        ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
    });
  }
  span.setAttribute("nestrix.ended_by", how);
  span.end();
}

/**
 * mysql2 publishes `mysql2:query` from inside the pool's getConnection callback. When
 * the pool had to queue the caller, that callback runs in the async context of whoever
 * released the connection, so `context.active()` is the wrong parent. `mysql2:pool:connect`
 * is published in the caller's context and its asyncStart/asyncEnd bracket the callback
 * synchronously, so the caller's context can be lent to any query started in between.
 */
const lentParents: Context[] = [];
const poolCallerContext = new WeakMap<object, Context>();

function subscribePoolParent(): void {
  dc.tracingChannel("mysql2:pool:connect").subscribe({
    start(message) {
      try {
        poolCallerContext.set(message as object, context.active());
      } catch {
        noteFailure("mysql2:pool:connect");
      }
    },
    end() {},
    asyncStart(message) {
      try {
        const ctx = poolCallerContext.get(message as object);
        lentParents.push(ctx ?? context.active());
      } catch {
        noteFailure("mysql2:pool:connect");
      }
    },
    asyncEnd() {
      try {
        lentParents.pop();
      } catch {
        noteFailure("mysql2:pool:connect");
      }
    },
    error() {},
  });
}

function subscribeTracing(
  channelName: string,
  tracerName: string,
  mapping: Mapping,
  useLentParent = false,
): void {
  const channel = dc.tracingChannel(channelName);
  const fault = `channel:${channelName}`;
  channel.subscribe({
    start(message) {
      try {
        maybeFault(fault);
        const ctx = message as Ctx;
        const span = trace.getTracer(tracerName).startSpan(
          mapping.name(ctx),
          {
            kind: SpanKind.CLIENT,
            attributes: {
              ...mapping.attributes(ctx),
              // Spike-only: which fields the library put on the context object.
              "nestrix.ctx_keys": Object.keys(ctx).sort().join(","),
            },
          },
          (useLentParent ? lentParents[lentParents.length - 1] : undefined) ??
            context.active(),
        );
        spans.set(ctx, span);
      } catch {
        noteFailure(fault);
      }
    },
    end(message) {
      try {
        // A synchronous throw publishes error then end, and nothing async.
        const ctx = message as Ctx;
        if (ctx.error !== undefined) finish(ctx, "end(sync error)");
      } catch {
        noteFailure(fault);
      }
    },
    asyncStart() {},
    asyncEnd(message) {
      try {
        finish(message as Ctx, "asyncEnd");
      } catch {
        noteFailure(fault);
      }
    },
    error() {
      // Recorded from ctx.error when the span ends.
    },
  });
}

let mysqlEnabled = false;
export function enableMysql2(
  options: {
    poolParent?: boolean;
    poolBindStore?: AsyncLocalStorage<unknown>;
  } = {},
): void {
  if (mysqlEnabled) return;
  mysqlEnabled = true;
  const poolParent = options.poolParent ?? true;
  if (poolParent) subscribePoolParent();
  const als = options.poolBindStore;
  if (als) {
    // Review F4, fuller fix: run the whole pool callback (and everything it schedules)
    // in the caller's context. Node's traceCallback calls the callback inside
    // asyncStart.runStores(), so a store bound here is entered for the callback.
    dc.tracingChannel("mysql2:pool:connect").asyncStart.bindStore(
      als as AsyncLocalStorage<object>,
      (message) => {
        try {
          return (poolCallerContext.get(message as object) ??
            als.getStore()) as object;
        } catch {
          noteFailure("mysql2:pool:connect:bindStore");
          return als.getStore() as object;
        }
      },
    );
  }
  for (const op of ["query", "execute"] as const) {
    subscribeTracing(
      `mysql2:${op}`,
      "nestrix-spike-mysql2",
      {
        name: (ctx) => `mysql2.${op} ${sqlOperation(ctx.query)}`,
        attributes: (ctx) => ({
          "db.system.name": "mysql",
          "db.query.text": sanitizeSql(ctx.query),
          "db.namespace": String(ctx.database ?? ""),
          "server.address": String(ctx.serverAddress ?? ""),
          "server.port": Number(ctx.serverPort ?? 0),
          // Bind values are carried on ctx.values but never recorded (rule 7).
          "nestrix.values_present": Array.isArray(ctx.values),
        }),
      },
      poolParent,
    );
  }
}

let redisEnabled = false;
export function enableIoredis(): void {
  if (redisEnabled) return;
  redisEnabled = true;
  subscribeTracing("ioredis:command", "nestrix-spike-ioredis", {
    name: (ctx) => `redis ${String(ctx.command ?? "").toUpperCase()}`,
    attributes: (ctx) => ({
      "db.system.name": "redis",
      "db.operation.name": String(ctx.command ?? ""),
      // ioredis sanitises args itself (unlisted commands become "?").
      "nestrix.redis.args": Array.isArray(ctx.args)
        ? (ctx.args as unknown[]).map(String).join(" ")
        : "",
      "db.namespace": String(ctx.database ?? ""),
      "server.address": String(ctx.serverAddress ?? ""),
      "server.port": Number(ctx.serverPort ?? 0),
    }),
  });
}
