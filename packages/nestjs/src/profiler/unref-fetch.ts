/**
 * The remote profiler's transport: a `fetch`-shaped function over `node:http` / `node:https` whose
 * sockets are unref'ed, so a request in flight never keeps a short-lived host process alive
 * (`fetch`/undici holds the event loop until the answer or its timeout). No dependency.
 *
 * - `agent: false`: one connection per request, no keep-alive pool left behind.
 * - Redirects are never followed; a 3xx is returned as it is (the caller counts it a failure).
 * - Aborting `init.signal` destroys the request and rejects with the signal's reason, as `fetch`
 *   does (`TimeoutError` for `AbortSignal.timeout`).
 * - The answer is a standard `Response`, so the poller reads it the same way as a `fetch` answer.
 *
 * Only the poller uses it, with a URL it built from the resolved export endpoint. It rejects URLs
 * with credentials, as `fetch` does. Imports no OpenTelemetry package.
 */
import type { IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

type Init = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
};

const NULL_BODY_STATUS = new Set([204, 205, 304]);

export function unrefFetch(
  input: string | URL,
  init: Init = {},
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const { signal } = init;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`unsupported protocol ${url.protocol}`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new TypeError("the URL must not include credentials");
    }
    const body =
      typeof init.body === "string"
        ? Buffer.from(init.body, "utf8")
        : init.body;
    const headers: Record<string, string | number> = {
      accept: "*/*",
      "accept-encoding": "identity",
      ...init.headers,
    };
    if (body !== undefined) headers["content-length"] = body.byteLength;

    let settled = false;
    const onAbort = () => {
      request.destroy(signal?.reason as Error);
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      settle();
    };

    const request = (url.protocol === "https:" ? https : http).request(
      url,
      { method: init.method ?? "GET", headers, agent: false },
      (message: IncomingMessage) => {
        finish(() => {
          const status = message.statusCode ?? 0;
          const answer = new Response(
            NULL_BODY_STATUS.has(status)
              ? null
              : (Readable.toWeb(message) as unknown as ReadableStream),
            {
              status,
              headers: message.headers as Record<string, string>,
            },
          );
          if (NULL_BODY_STATUS.has(status)) message.resume();
          resolve(answer);
        });
      },
    );
    request.on("socket", (socket) => socket.unref());
    request.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      finish(() => reject(signal?.aborted ? signal.reason : error));
    });
    request.on("close", () => signal?.removeEventListener("abort", onAbort));
    signal?.addEventListener("abort", onAbort, { once: true });
    request.end(body);
  });
}
