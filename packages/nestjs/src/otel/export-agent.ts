/**
 * The HTTP agents the OTLP exporter sends through, passed as its `httpAgentOptions`
 * factory (otlp-exporter-base 0.301.1 `convert-legacy-node-http-options.mjs:7`: a
 * function there is used as the agent factory as is).
 *
 * Two jobs, both so a closing app's process can exit:
 * - every socket is unref'ed, including while a request is on it. Node's `Agent`
 *   unrefs only idle keep-alive sockets (`keepSocketAlive`) and refs them again on reuse
 *   (`reuseSocket`), so a request hanging on a dead collector holds the process.
 * - `abort()` destroys every open socket with an error the exporter does not retry
 *   (its retryable set is `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `ETIMEDOUT`,
 *   `EAI_AGAIN`, `ENOTFOUND`, `ENETUNREACH`, `EHOSTUNREACH`;
 *   `http-transport-utils.mjs:115-127`), and fails every later connection the same way.
 */
import { subscribe } from "node:diagnostics_channel";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Duplex } from "node:stream";

export const SHUTDOWN_ERROR_CODE = "ERR_NESTRIX_TELEMETRY_SHUTDOWN";

/**
 * The HTTP status of the last answer an exporter got through these agents (D-82). The OTLP
 * exporter drops it for the statuses it retries (429, 502, 503, 504: its final error is a bare
 * "Export failed with retryable status"; otlp-exporter-base 0.301.1 `http-transport-utils.mjs`,
 * `otlp-export-delegate.mjs`), so it is read here, from Node's public
 * `http.client.response.finish` channel, for requests sent through one of these agents only.
 */
export interface ResponseStatusTracker {
  lastStatus: number | undefined;
}

const RESPONSE_FINISH = "http.client.response.finish";
const trackedAgents = new WeakMap<object, ResponseStatusTracker>();
let subscribed = false;

/**
 * Subscriber of `http.client.response.finish`: one `WeakMap` lookup per response the process
 * receives, so subscribed once, on the first tracked agent, and kept. Never throws (a throwing
 * subscriber raises `uncaughtException`).
 */
function onResponseFinish(message: unknown): void {
  try {
    const m = message as {
      request?: { agent?: unknown };
      response?: { statusCode?: unknown };
    } | null;
    const agent = m?.request?.agent;
    if (agent === null || typeof agent !== "object") return;
    const tracker = trackedAgents.get(agent);
    if (tracker === undefined) return;
    const status = m?.response?.statusCode;
    if (typeof status === "number") tracker.lastStatus = status;
  } catch {
    // Never throws into Node's HTTP client.
  }
}

function track(
  agent: object,
  tracker: ResponseStatusTracker | undefined,
): void {
  if (tracker === undefined) return;
  try {
    trackedAgents.set(agent, tracker);
    if (!subscribed) {
      subscribe(RESPONSE_FINISH, onResponseFinish);
      subscribed = true;
    }
  } catch {
    // Without the channel, a retried status is reported as `other`.
  }
}

function shutdownError(): Error {
  return Object.assign(new Error("Nestrix telemetry shut down"), {
    code: SHUTDOWN_ERROR_CODE,
  });
}

function unref(socket: Duplex | null | undefined): void {
  try {
    (socket as { unref?: () => void } | null | undefined)?.unref?.();
  } catch {
    // Best effort.
  }
}

export interface ExportAgents {
  /** For the exporter's `httpAgentOptions`: `(protocol) => Agent`. */
  factory(protocol: string): HttpAgent;
  abort(): void;
}

export function createExportAgents(
  tracker?: ResponseStatusTracker,
): ExportAgents {
  const sockets = new Set<Duplex>();
  let aborted = false;

  const trackSocket = (socket: Duplex | null | undefined): void => {
    if (!socket) return;
    unref(socket);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (aborted) process.nextTick(() => socket.destroy(shutdownError()));
  };

  // Mirrors the exporter's default (`httpAgentFactoryFromOptions({ keepAlive: true })`).
  class UnrefHttpAgent extends HttpAgent {
    override createConnection(
      ...args: Parameters<HttpAgent["createConnection"]>
    ): ReturnType<HttpAgent["createConnection"]> {
      const socket = super.createConnection(...args);
      trackSocket(socket);
      return socket;
    }
    override reuseSocket(...args: Parameters<HttpAgent["reuseSocket"]>): void {
      super.reuseSocket(...args);
      unref(args[0]);
    }
  }
  class UnrefHttpsAgent extends HttpsAgent {
    override createConnection(
      ...args: Parameters<HttpsAgent["createConnection"]>
    ): ReturnType<HttpsAgent["createConnection"]> {
      const socket = super.createConnection(...args);
      trackSocket(socket);
      return socket;
    }
    override reuseSocket(...args: Parameters<HttpsAgent["reuseSocket"]>): void {
      super.reuseSocket(...args);
      unref(args[0]);
    }
  }

  let http: HttpAgent | undefined;
  let https: HttpsAgent | undefined;
  return {
    factory(protocol) {
      if (protocol === "http:") {
        if (http === undefined) {
          http = new UnrefHttpAgent({ keepAlive: true });
          track(http, tracker);
        }
        return http;
      }
      if (https === undefined) {
        https = new UnrefHttpsAgent({ keepAlive: true });
        track(https, tracker);
      }
      return https;
    },
    abort() {
      aborted = true;
      for (const socket of [...sockets]) {
        try {
          socket.destroy(shutdownError());
        } catch {
          // Best effort.
        }
      }
    },
  };
}
