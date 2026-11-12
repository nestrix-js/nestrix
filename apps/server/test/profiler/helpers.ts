import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { ApiTokenCreateResponse } from "@nestrix-js/protocol";
import type { AlertsServer } from "../alerts/helpers.js";
import { type RawResult, rawRequest } from "../auth/helpers.js";
import { KEY } from "../ingest/helpers.js";

/**
 * A small CPU profile in V8's form: `(root)` with `(program)`, `(idle)` and `main` → `work`.
 * Samples: work ×4, main ×1, (program) ×1, (idle) ×1. 30 s long.
 */
export function sampleProfile(): Record<string, unknown> {
  const frame = (functionName: string, url = "", line = -1, column = -1) => ({
    functionName,
    scriptId: url === "" ? 0 : 7,
    url,
    lineNumber: line,
    columnNumber: column,
  });
  return {
    nodes: [
      { id: 1, callFrame: frame("(root)"), hitCount: 0, children: [2, 3, 4] },
      { id: 2, callFrame: frame("(program)"), hitCount: 1 },
      { id: 3, callFrame: frame("(idle)"), hitCount: 1 },
      {
        id: 4,
        callFrame: frame("main", "/app/main.js", 0, 0),
        hitCount: 1,
        children: [5],
      },
      {
        id: 5,
        callFrame: frame("work", "/app/work.js", 9, 2),
        hitCount: 4,
        positionTicks: [{ line: 10, ticks: 4 }],
      },
    ],
    startTime: 1_000,
    endTime: 1_000 + 30_000_000,
    samples: [5, 5, 4, 5, 2, 3, 5],
    timeDeltas: [10, 10, 10, 10, 10, 10, 10],
  };
}

/** Creates a read-only API token from the admin session and returns it. */
export async function createReaderToken(server: AlertsServer): Promise<string> {
  const res = await server.call("POST", "/api/v1/tokens", { name: "reader" });
  if (res.status !== 201) throw new Error(`token create failed: ${res.status}`);
  const created = (await res.json()) as ApiTokenCreateResponse;
  const value: unknown = created.secret;
  if (typeof value !== "string") throw new Error("no token in the answer");
  return value;
}

export interface Instance {
  service: string;
  instanceId: string;
}

export function newInstance(service: string): Instance {
  return { service, instanceId: randomUUID() };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export function checkIn(
  baseUrl: string,
  body: unknown,
  key = KEY,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/nestrix/check-in`, {
    method: "POST",
    headers: {
      ...bearer(key),
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function upload(
  baseUrl: string,
  id: string,
  profile: unknown,
  key = KEY,
  options: { gzip?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> {
  const json = typeof profile === "string" ? profile : JSON.stringify(profile);
  const gzip = options.gzip ?? true;
  const body = gzip ? Uint8Array.from(gzipSync(json)) : json;
  return fetch(`${baseUrl}/v1/nestrix/profiles/${id}`, {
    method: "POST",
    headers: {
      ...bearer(key),
      "content-type": "application/json",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
      ...options.headers,
    },
    body,
  });
}

export function reportFailed(
  baseUrl: string,
  id: string,
  body: unknown,
  key = KEY,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/nestrix/profiles/${id}/failed`, {
    method: "POST",
    headers: { ...bearer(key), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * `POST /api/v1/remote-profiles` as the dashboard page sends it: session cookie, same-origin
 * `Origin` and `Sec-Fetch-Site`, JSON with a `Content-Length`. `headers` overrides or, set to
 * `null`, removes one.
 */
export function startCapture(
  server: AlertsServer,
  body: unknown,
  headers: Record<string, string | null> = {},
  target = "/api/v1/remote-profiles",
): Promise<RawResult> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const merged: Record<string, string | null> = {
    cookie: server.cookie,
    origin: server.origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
    ...headers,
  };
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (value !== null) sent[name] = value;
  }
  return rawRequest(server.baseUrl, "POST", target, sent, text);
}
