import { request as httpRequest } from "node:http";
import {
  SESSION_COOKIE,
  sessionKey,
  signSession,
} from "../../src/auth/session.js";
import { startServer, type TestServer, testConfig } from "../ingest/helpers.js";

/** Test-only admin credential and session secret (obviously not real ones). */
export const ADMIN_PW = "a".repeat(24);
export const SESSION_SECRET = "s".repeat(40);

/** A server with an admin password and a fixed session secret. */
export function startAuthServer(
  env: Record<string, string> = {},
): Promise<TestServer> {
  return startServer(
    testConfig({
      NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
      NESTRIX_SESSION_SECRET: SESSION_SECRET,
      ...env,
    }),
  );
}

/** `Origin` of the server as a browser on its page would send it. */
export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** `POST /login` with a form body, as the login page's form sends it. */
export function postLogin(
  baseUrl: string,
  pw: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: originOf(baseUrl),
      ...headers,
    },
    body: new URLSearchParams({ password: pw }).toString(),
  });
}

/** The `name=value` part of a `Set-Cookie` header. */
export function cookiePair(setCookie: string | null): string {
  if (!setCookie) throw new Error("no Set-Cookie header");
  return setCookie.split(";", 1)[0] as string;
}

/** Signs in and returns the `Cookie` header value for later requests. */
export async function loginCookie(baseUrl: string): Promise<string> {
  const res = await postLogin(baseUrl, ADMIN_PW);
  if (res.status !== 303) throw new Error(`login failed: ${res.status}`);
  return cookiePair(res.headers.get("set-cookie"));
}

export interface RawResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * A request with exactly the target and headers given (`fetch` normalizes paths and forbids
 * some headers, such as `Host` and `Sec-Fetch-Site`). `headers` may be a raw list, to send a
 * header twice.
 */
export function rawRequest(
  baseUrl: string,
  method: string,
  target: string,
  headers: Record<string, string> | string[] = {},
  body?: string,
): Promise<RawResult> {
  const url = new URL(baseUrl);
  const names = Array.isArray(headers)
    ? headers.filter((_, i) => i % 2 === 0)
    : Object.keys(headers);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: target,
        headers,
        setHost: !names.some((h) => h.toLowerCase() === "host"),
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A session cookie signed directly with the test server's key (no login, no rate limit). */
export function signedCookie(
  expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600,
  secret = SESSION_SECRET,
  pw = ADMIN_PW,
): string {
  const key = sessionKey(Buffer.from(secret, "utf8"), pw);
  return `${SESSION_COOKIE}=${signSession(key, expiresAtSeconds)}`;
}

/** Every response header name that starts with `access-control-`. */
export function corsHeaders(headers: Headers | RawResult["headers"]): string[] {
  const names =
    headers instanceof Headers ? [...headers.keys()] : Object.keys(headers);
  return names.filter((n) => n.toLowerCase().startsWith("access-control-"));
}
