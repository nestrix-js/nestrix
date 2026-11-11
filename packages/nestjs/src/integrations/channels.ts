/**
 * `mysql2` and `ioredis` spans from the TracingChannels both libraries publish (architecture
 * §4.4; reference: `spikes/p0-s2/src/nestrix/channels.ts`). Opt-in (D-49): subscribing to any
 * sub-channel makes mysql2 swallow an error from an event-emitter query with no `'error'`
 * listener, and ioredis swallow the rejection of a failing command nobody awaits.
 *
 * A span starts in `start`, which the library publishes synchronously in the caller's async
 * context, and ends in `asyncStart` (the result is in, the caller's callback or continuation has
 * not run yet), so it covers the query only (D-59). A synchronous throw publishes `error` then
 * `end` and nothing async; the span ends at `end` then. Errors arrive on `message.error`.
 *
 * mysql2 pool context fix (P0-S2 Q3): when the pool queues a caller, `mysql2:query` is published
 * inside the getConnection callback, which runs in the async context of whoever released the
 * connection. `mysql2:pool:connect` is published in the caller's context and its
 * `asyncStart`/`asyncEnd` bracket that callback synchronously, so the caller's context is lent to
 * a query started synchronously inside the callback, unless the callback switched context itself.
 * A query the callback starts on a later tick is still misparented; the fuller fix needs Nestrix
 * to own the context manager's AsyncLocalStorage (§4.4) and is not used.
 *
 * ioredis: a command with no active span (connection handshakes, commands queued before the
 * connection was ready) gets no span unless `rootSpans` is on (D-60). `ioredis:batch` (MULTI) and
 * `ioredis:connect` are not subscribed. The recorded text is the command and its first argument
 * as ioredis sanitised it (`GET user:1`, `SET user:1`), never values.
 *
 * Every handler catches everything (rule 1): a throwing diagnostics-channel subscriber raises
 * `uncaughtException`.
 */
import dc from "node:diagnostics_channel";
import { type Context, context, type Span } from "@opentelemetry/api";
import type { Diagnostics } from "../diagnostics.js";
import {
  type DbCall,
  endDbSpan,
  fault,
  hasActiveSpan,
  isSuppressed,
  startDbSpan,
  toPort,
  toText,
} from "./db-span.js";
import { sanitizeSql, sqlOperation, sqlTarget } from "./sql.js";

export const MYSQL2_CHANNELS = {
  query: "mysql2:query",
  execute: "mysql2:execute",
  poolConnect: "mysql2:pool:connect",
} as const;

export const IOREDIS_CHANNELS = { command: "ioredis:command" } as const;

/** The longest Redis key recorded in `db.query.text`. */
export const MAX_REDIS_KEY_LENGTH = 256;

type Message = Record<string, unknown> & { error?: unknown };

interface Handlers {
  start?(message: unknown): void;
  end?(message: unknown): void;
  asyncStart?(message: unknown): void;
  asyncEnd?(message: unknown): void;
  error?(message: unknown): void;
}

/** A subscription that can be undone. */
interface Subscribed {
  readonly name: string;
  readonly handlers: Handlers;
}

function subscribeAll(
  list: ReadonlyArray<[string, Handlers]>,
  diagnostics: Diagnostics,
  site: string,
): Subscribed[] {
  const subscribed: Subscribed[] = [];
  for (const [name, handlers] of list) {
    try {
      dc.tracingChannel(name).subscribe(handlers as never);
      subscribed.push({ name, handlers });
    } catch (error) {
      diagnostics.countFailure(`integrations.${site}.subscribe`, error);
    }
  }
  return subscribed;
}

function unsubscribeAll(
  subscribed: readonly Subscribed[],
  diagnostics: Diagnostics,
  site: string,
): void {
  for (const { name, handlers } of subscribed) {
    try {
      dc.tracingChannel(name).unsubscribe(handlers as never);
    } catch (error) {
      diagnostics.countFailure(`integrations.${site}.unsubscribe`, error);
    }
  }
}

/**
 * Span handlers for one TracingChannel. `parentOf` returns the parent context, or `undefined`
 * for no span; `callOf` describes the call.
 */
function spanHandlers(
  site: string,
  diagnostics: Diagnostics,
  parentOf: () => Context | undefined,
  callOf: (message: Message) => DbCall,
): Handlers {
  const spans = new WeakMap<object, Span>();
  const finish = (message: Message): void => {
    const span = spans.get(message);
    if (span === undefined) return;
    spans.delete(message);
    endDbSpan(span, message.error);
  };
  return {
    start(message) {
      try {
        fault(`${site}.start`);
        const parent = parentOf();
        if (parent === undefined) return;
        const m = message as Message;
        spans.set(m, startDbSpan(callOf(m), parent));
      } catch (error) {
        diagnostics.countFailure(`integrations.${site}.start`, error);
      }
    },
    end(message) {
      try {
        fault(`${site}.end`);
        // Only a synchronous throw has set `error` by now (or a callback called synchronously).
        if ((message as Message).error !== undefined)
          finish(message as Message);
      } catch (error) {
        diagnostics.countFailure(`integrations.${site}.end`, error);
      }
    },
    asyncStart(message) {
      try {
        fault(`${site}.asyncStart`);
        finish(message as Message);
      } catch (error) {
        diagnostics.countFailure(`integrations.${site}.asyncStart`, error);
      }
    },
    asyncEnd(message) {
      try {
        // Normally ended at asyncStart already; this is a safety net.
        finish(message as Message);
      } catch (error) {
        diagnostics.countFailure(`integrations.${site}.asyncEnd`, error);
      }
    },
    error() {
      // Recorded from `message.error` when the span ends.
    },
  };
}

// ---------------------------------------------------------------------------------------------
// mysql2
// ---------------------------------------------------------------------------------------------

interface Lent {
  /** The pool caller's context. */
  readonly caller: Context;
  /** The context active when the pool callback began (the releasing caller's). */
  readonly at: Context;
}

function mysql2Subscriptions(
  diagnostics: Diagnostics,
): Array<[string, Handlers]> {
  const callers = new WeakMap<object, Context>();
  const lent: Lent[] = [];

  const poolConnect: Handlers = {
    start(message) {
      try {
        fault("mysql2.pool.start");
        callers.set(message as object, context.active());
      } catch (error) {
        diagnostics.countFailure("integrations.mysql2.pool.start", error);
      }
    },
    asyncStart(message) {
      try {
        fault("mysql2.pool.asyncStart");
        const caller = callers.get(message as object);
        // Always push, so asyncEnd's pop stays paired.
        const at = context.active();
        lent.push({ caller: caller ?? at, at });
      } catch (error) {
        diagnostics.countFailure("integrations.mysql2.pool.asyncStart", error);
      }
    },
    asyncEnd() {
      try {
        lent.pop();
      } catch (error) {
        diagnostics.countFailure("integrations.mysql2.pool.asyncEnd", error);
      }
    },
  };

  const parentOf = (): Context | undefined => {
    const active = context.active();
    const top = lent[lent.length - 1];
    const parent = top !== undefined && active === top.at ? top.caller : active;
    return isSuppressed(parent) ? undefined : parent;
  };

  const callOf = (m: Message): DbCall => {
    // `query()` interpolates values into the text client-side; the sanitiser removes them.
    const text = sanitizeSql(m.query, "mysql");
    const operation = sqlOperation(text);
    return {
      system: "mysql",
      text,
      operation,
      target: sqlTarget(text, operation),
      namespace: toText(m.database),
      address: toText(m.serverAddress),
      port: toPort(m.serverPort),
    };
  };

  return [
    [MYSQL2_CHANNELS.poolConnect, poolConnect],
    [
      MYSQL2_CHANNELS.query,
      spanHandlers("mysql2.query", diagnostics, parentOf, callOf),
    ],
    [
      MYSQL2_CHANNELS.execute,
      spanHandlers("mysql2.execute", diagnostics, parentOf, callOf),
    ],
  ];
}

// ---------------------------------------------------------------------------------------------
// ioredis
// ---------------------------------------------------------------------------------------------

/**
 * Commands recorded by name only: the first argument is a secret even if a library version does
 * not sanitise it (`AUTH`, `HELLO`), or a script body or script reference (`EVAL`, `FCALL`, …).
 */
const SECRET_FIRST_ARGUMENT: ReadonlySet<string> = new Set([
  "AUTH",
  "HELLO",
  "EVAL",
  "EVAL_RO",
  "EVALSHA",
  "EVALSHA_RO",
  "FCALL",
  "FCALL_RO",
  "SCRIPT",
]);

export function redisText(
  command: string | undefined,
  args: unknown,
): string | undefined {
  if (command === undefined) return undefined;
  if (SECRET_FIRST_ARGUMENT.has(command) || !Array.isArray(args))
    return command;
  const first = args[0];
  if (typeof first !== "string" || first === "?" || first === "")
    return command;
  const key =
    first.length > MAX_REDIS_KEY_LENGTH
      ? first.slice(0, MAX_REDIS_KEY_LENGTH)
      : first;
  return `${command} ${key}`;
}

function ioredisSubscriptions(
  diagnostics: Diagnostics,
  rootSpans: boolean,
): Array<[string, Handlers]> {
  const parentOf = (): Context | undefined => {
    const active = context.active();
    if (isSuppressed(active)) return undefined;
    if (!rootSpans && !hasActiveSpan(active)) return undefined;
    return active;
  };
  const callOf = (m: Message): DbCall => {
    const command =
      typeof m.command === "string" && m.command !== ""
        ? m.command.toUpperCase()
        : undefined;
    return {
      system: "redis",
      text: redisText(command, m.args),
      operation: command,
      target: undefined,
      namespace: toText(m.database),
      address: toText(m.serverAddress),
      port: toPort(m.serverPort),
    };
  };
  return [
    [
      IOREDIS_CHANNELS.command,
      spanHandlers("ioredis.command", diagnostics, parentOf, callOf),
    ],
  ];
}

// ---------------------------------------------------------------------------------------------
// Installation (one per process per library, reference-counted like the outbound subscribers)
// ---------------------------------------------------------------------------------------------

interface Installation {
  readonly subscribed: Subscribed[];
  readonly diagnostics: Diagnostics;
  references: number;
}

const installations: Record<"mysql2" | "ioredis", Installation | undefined> = {
  mysql2: undefined,
  ioredis: undefined,
};

function install(
  which: "mysql2" | "ioredis",
  diagnostics: Diagnostics,
  build: () => Array<[string, Handlers]>,
): () => void {
  try {
    let installation = installations[which];
    if (installation === undefined) {
      installation = {
        subscribed: subscribeAll(build(), diagnostics, which),
        diagnostics,
        references: 0,
      };
      installations[which] = installation;
    } else {
      diagnostics.logOnce(
        `integrations.${which}.second-instance`,
        `The ${which} integration is already installed by another Nestrix instance in this process; it stays installed while either runs, with the first instance's options.`,
      );
    }
    const current = installation;
    current.references++;
    let released = false;
    return () => {
      try {
        if (released) return;
        released = true;
        current.references--;
        if (current.references === 0 && installations[which] === current) {
          installations[which] = undefined;
          unsubscribeAll(current.subscribed, current.diagnostics, which);
        }
      } catch (error) {
        diagnostics.countFailure(`integrations.${which}.uninstall`, error);
      }
    };
  } catch (error) {
    diagnostics.countFailure(`integrations.${which}.install`, error);
    return () => undefined;
  }
}

export function subscribeMysql2(diagnostics: Diagnostics): () => void {
  return install("mysql2", diagnostics, () => mysql2Subscriptions(diagnostics));
}

export function subscribeIoredis(
  diagnostics: Diagnostics,
  options: { rootSpans: boolean },
): () => void {
  return install("ioredis", diagnostics, () =>
    ioredisSubscriptions(diagnostics, options.rootSpans),
  );
}
