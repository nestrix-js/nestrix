import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** node:http GET that never decompresses, so bodies can be compared byte for byte. */
export function get(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; json: unknown }> {
  const r = await get(url, headers);
  let json: unknown;
  try {
    json = JSON.parse(r.body.toString("utf8"));
  } catch {
    json = r.body.toString("utf8");
  }
  return { status: r.status, headers: r.headers, json };
}

/** Writes `raw` verbatim on a TCP socket and returns everything read until the server closes. */
export function rawHttp(
  host: string,
  port: number,
  raw: string,
): Promise<{ statusLine: string; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.write(raw));
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const i = text.indexOf("\r\n\r\n");
      const head = i === -1 ? text : text.slice(0, i);
      resolve({
        statusLine: head.split("\r\n")[0] ?? "",
        head,
        body: i === -1 ? "" : text.slice(i + 4),
      });
    });
    socket.setTimeout(3000, () => {
      socket.destroy(new Error("raw socket timeout"));
    });
  });
}

export function portOf(baseUrl: string): number {
  return Number(new URL(baseUrl).port);
}

/** Prints an observation line that survives Vitest's console capture. */
export function note(label: string, value: unknown): void {
  process.stderr.write(`OBS ${label} ${JSON.stringify(value)}\n`);
}

/** Header names on a response that a cross-origin reader would care about. */
export function corsHeaders(h: IncomingHttpHeaders): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(h).filter(([k]) => k.startsWith("access-control-")),
  );
}
