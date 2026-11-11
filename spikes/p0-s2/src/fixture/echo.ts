import http from "node:http";
import type { AddressInfo } from "node:net";

/** Raw node:http server the fixture calls out to. Records the headers it receives. */
export interface Echo {
  url: string;
  received: Array<{ path: string; traceparent: string | string[] | undefined }>;
  close: () => Promise<void>;
}

export async function startEcho(): Promise<Echo> {
  const received: Echo["received"] = [];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    received.push({ path, traceparent: req.headers.traceparent });
    switch (path) {
      case "/500":
        res.statusCode = 500;
        res.end("fail");
        return;
      case "/slow-body":
        // Headers now, body 300 ms later: shows when response.finish fires.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("part 1\n");
        setTimeout(() => res.end("part 2\n"), 300);
        return;
      case "/big":
      case "/big-dumped":
        // Larger than the socket buffers, so an unread body really stays unread.
        res.end("x".repeat(200_000));
        return;
      case "/destroy":
        req.socket.destroy();
        return;
      case "/hang":
        // Never answers; the client aborts.
        return;
      default:
        res.end("ok");
    }
  });
  server.keepAliveTimeout = 100;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
