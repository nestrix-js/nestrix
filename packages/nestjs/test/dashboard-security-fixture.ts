// Helpers for dashboard-security.test.ts (P2-07). Not a test file itself.
//
// Raw TCP, because `fetch` and `node:http` normalise or refuse exactly the things the security
// rules look at: a missing or duplicated `Host`, HTTP/1.0, header spelling and order.
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

export interface RawReply {
  status: number;
  statusLine: string;
  /** Lower-case names; a repeated header is joined with `, `. */
  headers: Record<string, string>;
  /** Every header line as sent, for repeated `Set-Cookie`. */
  headLines: string[];
  body: string;
}

/**
 * Writes `request` verbatim to `host:port` and returns the parsed reply once the server closes the
 * connection. Callers put `Connection: close` in the request (HTTP/1.0 closes by itself). Only
 * suited to replies with a `Content-Length` or no body (the replies this file reads).
 */
export function rawRequest(
  port: number,
  request: string,
  host = "127.0.0.1",
): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.write(request));
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const i = text.indexOf("\r\n\r\n");
      const head = i === -1 ? text : text.slice(0, i);
      const lines = head.split("\r\n");
      const statusLine = lines[0] ?? "";
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
      }
      resolve({
        status: Number(statusLine.split(" ")[1] ?? 0),
        statusLine,
        headers,
        headLines: lines.slice(1),
        body: i === -1 ? "" : text.slice(i + 4),
      });
    });
    socket.setTimeout(3000, () =>
      socket.destroy(new Error("raw socket timeout")),
    );
  });
}

/** An HTTP/1.1 request as text: each entry of `headers` is one header line, in order. */
export function http11(
  path: string,
  headers: string[],
  method = "GET",
): string {
  return `${method} ${path} HTTP/1.1\r\n${headers.join("\r\n")}${
    headers.length > 0 ? "\r\n" : ""
  }Connection: close\r\n\r\n`;
}

/** An HTTP/1.0 request as text (no `Host` unless a line says so). */
export function http10(path: string, headers: string[] = []): string {
  return `GET ${path} HTTP/1.0\r\n${headers.join("\r\n")}${
    headers.length > 0 ? "\r\n" : ""
  }\r\n`;
}

/** The first non-internal IPv4 address of this machine, if it has one. */
export function externalIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("127.")
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
}

export interface SameHostProxy {
  port: number;
  /** Headers of the last request the proxy sent upstream. */
  lastUpstreamHeaders(): IncomingHttpHeaders;
  close(): Promise<void>;
}

/**
 * A reverse proxy on the same host as the app, the nginx default of
 * `proxy_pass http://127.0.0.1:<port>` (spike P0-S5 Q7): it rewrites `Host` to the upstream
 * address, adds no forwarding header, and connects from 127.0.0.1. It forwards `Cookie` and
 * `Authorization` untouched, as nginx does.
 */
export function startSameHostProxy(
  upstreamPort: number,
): Promise<SameHostProxy> {
  let last: IncomingHttpHeaders = {};
  const server: Server = createServer((req, res) => {
    const headers: IncomingHttpHeaders = { ...req.headers };
    headers.host = `127.0.0.1:${upstreamPort}`;
    last = headers;
    const up = httpRequest(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        lastUpstreamHeaders: () => last,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
