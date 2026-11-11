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
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Duplex } from "node:stream";

export const SHUTDOWN_ERROR_CODE = "ERR_NESTRIX_TELEMETRY_SHUTDOWN";

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

export function createExportAgents(): ExportAgents {
  const sockets = new Set<Duplex>();
  let aborted = false;

  const track = (socket: Duplex | null | undefined): void => {
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
      track(socket);
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
      track(socket);
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
        http ??= new UnrefHttpAgent({ keepAlive: true });
        return http;
      }
      https ??= new UnrefHttpsAgent({ keepAlive: true });
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
