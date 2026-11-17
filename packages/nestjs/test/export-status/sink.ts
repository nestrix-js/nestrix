// A local OTLP/HTTP sink that answers chosen statuses per path, for the export-status tests.
// Not a test file itself.
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StatusSink {
  /** Base URL, no path: pass it as `export.otlp.endpoint`. */
  base: string;
  /** Status per path (`/v1/traces`, `/v1/metrics`, `/v1/logs`); 200 when unset. */
  status: Record<string, number>;
  /** Extra headers per path (e.g. `retry-after`). */
  headers: Record<string, Record<string, string>>;
  /** Delay before answering, per path, in ms. */
  delay: Record<string, number>;
  /** Requests per path. */
  hits: Record<string, number>;
  count(path: string): number;
  /** Stops listening and drops every connection (the backend is down). */
  down(): Promise<void>;
  /** Listens again on the same port. */
  up(): Promise<void>;
  close(): Promise<void>;
}

export async function startStatusSink(): Promise<StatusSink> {
  const sink = {
    base: "",
    status: {},
    headers: {},
    delay: {},
    hits: {},
  } as StatusSink;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "";
      sink.hits[path] = (sink.hits[path] ?? 0) + 1;
      const answer = () => {
        const status = sink.status[path] ?? 200;
        res.writeHead(status, {
          "content-type": "application/json",
          ...sink.headers[path],
        });
        res.end(status < 300 ? "{}" : JSON.stringify({ message: "refused" }));
      };
      const delay = sink.delay[path] ?? 0;
      if (delay > 0) setTimeout(answer, delay);
      else answer();
    });
  });
  server.keepAliveTimeout = 100;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  sink.base = `http://127.0.0.1:${port}`;
  sink.count = (path) => sink.hits[path] ?? 0;
  sink.down = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  sink.up = async () => {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
  };
  sink.close = async () => {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  return sink;
}
