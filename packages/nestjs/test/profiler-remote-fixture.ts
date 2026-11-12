// A fake standalone server for the remote profiler tests (P10-01). Plain `node:http`; not a test
// file itself. Records every request and answers through a replaceable `respond`.
import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

export interface Hit {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** As received (still gzipped for an upload). */
  readonly body: Buffer;
  readonly at: number;
}

/** `hang`: never answer (the request stays open until the client aborts or the server closes). */
export type Answer =
  | { status: number; json?: unknown; headers?: Record<string, string> }
  | "hang";

export interface FakeServer {
  readonly url: string;
  readonly hits: Hit[];
  /** Requests whose connection closed before an answer was sent (client aborts). */
  aborted: number;
  respond: (hit: Hit) => Answer;
  checkIns(): Hit[];
  close(): Promise<void>;
}

export const CHECK_IN = "/v1/nestrix/check-in";

/** Default: every check-in gets "nothing to do"; everything else 204. */
export function defaultAnswer(hit: Hit): Answer {
  if (hit.path === CHECK_IN) {
    return { status: 200, json: { nextCheckInMs: 15_000 } };
  }
  if (hit.path === "/v1/traces") return { status: 200, json: {} };
  return { status: 204 };
}

export async function startFakeServer(): Promise<FakeServer> {
  const state: FakeServer = {
    url: "",
    hits: [],
    aborted: 0,
    respond: defaultAnswer,
    checkIns: () => state.hits.filter((h) => h.path === CHECK_IN),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit: Hit = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
        at: Date.now(),
      };
      state.hits.push(hit);
      let answer: Answer;
      try {
        answer = state.respond(hit);
      } catch {
        answer = { status: 500 };
      }
      if (answer === "hang") {
        res.on("close", () => {
          if (!res.writableEnded) state.aborted++;
        });
        return;
      }
      send(res, answer);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  (state as { url: string }).url = `http://127.0.0.1:${port}`;
  return state;
}

function send(res: ServerResponse, answer: Exclude<Answer, "hang">): void {
  const body = answer.json === undefined ? "" : JSON.stringify(answer.json);
  res.writeHead(answer.status, {
    ...(body ? { "content-type": "application/json" } : {}),
    ...answer.headers,
  });
  res.end(body);
}

/** The JSON of a request body, gunzipped first when the request says gzip. */
export function bodyJson(hit: Hit): unknown {
  const raw =
    hit.headers["content-encoding"] === "gzip"
      ? gunzipSync(hit.body)
      : hit.body;
  return JSON.parse(raw.toString("utf8"));
}

/** Resolves once `predicate` holds; polls every 5 ms. */
export async function until(
  predicate: () => boolean,
  timeoutMs = 3000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
