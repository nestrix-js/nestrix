// A plain node:http server that serves dist/ the way the Nestrix dashboard handlers will:
// index.html templated per request, one exact route per manifest file, and the exact
// response headers from docs/backlog/phase-2.md "Public API". It is a stand-in for P2-06,
// not its code.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { MockApi } from "./mock-api.ts";

export const BASE_PATH = "/some/deep/_nestrix";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

const securityHeaders = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

interface ManifestFile {
  path: string;
  contentType: string;
}

const manifest = JSON.parse(readFileSync(`${dist}manifest.json`, "utf8")) as {
  files: ManifestFile[];
};
const assets = new Map(
  manifest.files
    .filter((f) => f.path.startsWith("assets/"))
    .map((f) => [f.path, f.contentType]),
);

function renderIndex(config: unknown): string {
  // `<` is escaped so a value can never close the script element.
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return readFileSync(`${dist}index.html`, "utf8")
    .replace("__NESTRIX_BASE_HREF__", () => `${BASE_PATH}/`)
    .replace('"__NESTRIX_CONFIG__"', () => json);
}

export function startServer(): Promise<{
  server: Server;
  origin: string;
  mock: MockApi;
}> {
  const mock = new MockApi();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const send = (
      status: number,
      headers: Record<string, string>,
      body: string | Buffer,
    ) => {
      res.writeHead(status, { ...securityHeaders, ...headers });
      res.end(body);
    };
    try {
      if (path === BASE_PATH || path === `${BASE_PATH}/`) {
        send(
          200,
          {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
          renderIndex({
            service: "demo-service",
            apiBase: "api/v1/",
            path: BASE_PATH,
            protocolVersion: 1,
          }),
        );
      } else if (path.startsWith(`${BASE_PATH}/api/v1/slos`)) {
        const rest = path.slice(`${BASE_PATH}/api/v1/slos`.length);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString("utf8");
        // A write needs the same-origin Origin, as the real server demands (403 otherwise).
        const origin = `http://${req.headers.host}`;
        const answer =
          req.method !== "GET" && req.headers.origin !== origin
            ? {
                status: 403,
                body: { error: { code: "forbidden", message: "Origin" } },
              }
            : mock.handleSlos(
                req.method ?? "GET",
                rest.startsWith("/") ? rest.slice(1) : null,
                text === "" ? undefined : JSON.parse(text),
              );
        send(
          answer.status,
          {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
          answer.body === undefined ? "" : JSON.stringify(answer.body),
        );
      } else if (path.startsWith(`${BASE_PATH}/api/v1/`)) {
        const answer = await mock.handle(
          path.slice(`${BASE_PATH}/api/v1/`.length),
          new URL(req.url ?? "/", "http://localhost").searchParams,
        );
        send(
          answer.status,
          {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
          JSON.stringify(answer.body),
        );
      } else if (path === `${BASE_PATH}/logout` && req.method === "POST") {
        mock.logouts += 1;
        send(204, { "Cache-Control": "no-store" }, "");
      } else if (path === `${BASE_PATH}/login`) {
        send(
          200,
          {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
          "<!doctype html><title>Sign in</title><h1>Sign in</h1>",
        );
      } else if (path === `${BASE_PATH}/__control__`) {
        // Negative control for the harness: the same headers, plus an inline script and an
        // inline style. If the harness does not flag this page it cannot be trusted.
        send(
          200,
          {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
          "<!doctype html><style>body{color:red}</style><script>window.inlineRan=true</script><p>control</p>",
        );
      } else if (
        path.startsWith(`${BASE_PATH}/assets/`) &&
        assets.has(path.slice(BASE_PATH.length + 1))
      ) {
        const file = path.slice(BASE_PATH.length + 1);
        send(
          200,
          {
            "Content-Type": assets.get(file) as string,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
          readFileSync(dist + file),
        );
      } else {
        send(404, { "Cache-Control": "no-store" }, "");
      }
    } catch {
      send(500, { "Cache-Control": "no-store" }, "");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}`, mock });
    });
  });
}
