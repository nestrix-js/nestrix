/**
 * API token failure limits (P8-01 security round), without a database: the middleware is driven
 * directly with a stub verifier and per-client socket addresses. One client's bad tokens must not
 * lock out another client's login or any valid token; misses are limited per client.
 */
import "reflect-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { AdminAuth } from "../../src/auth/admin-auth.js";
import { generateApiToken } from "../../src/auth/api-tokens.js";
import { LoginRateLimiter } from "../../src/auth/login-rate-limit.js";
import { testConfig } from "../ingest/helpers.js";
import { ADMIN_PW, SESSION_SECRET } from "./helpers.js";

interface Outcome {
  passed: boolean;
  status: number;
  headers: Map<string, unknown>;
}

function setup() {
  const auth = new AdminAuth(
    testConfig({
      NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
      NESTRIX_SESSION_SECRET: SESSION_SECRET,
    }),
  );
  const good = generateApiToken();
  auth.useTokenVerifier({
    verify: async (t) => (t === good ? { id: "1" } : undefined),
  });

  const run = (
    address: string,
    init: { method?: string; url: string; token?: string; body?: unknown },
  ): Promise<Outcome> =>
    new Promise((resolve) => {
      const headers = new Map<string, unknown>();
      const response = {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        setHeader: (n: string, v: unknown) => headers.set(n.toLowerCase(), v),
        getHeaderNames: () => [...headers.keys()],
        removeHeader: (n: string) => headers.delete(n),
        writeHead: () => response,
        end() {
          resolve({ passed: false, status: response.statusCode, headers });
        },
      } as unknown as ServerResponse;
      const raw =
        init.token === undefined
          ? ["Host", "localhost", "Origin", "http://localhost"]
          : [
              "Host",
              "localhost",
              "Origin",
              "http://localhost",
              "Authorization",
              `Bearer ${init.token}`,
            ];
      const request = {
        method: init.method ?? "GET",
        url: init.url,
        headers: { host: "localhost", origin: "http://localhost" },
        rawHeaders: raw,
        socket: { remoteAddress: address },
        body: init.body,
      } as unknown as IncomingMessage;
      auth.middleware()(request, response, () => {
        // `/login` is stamped by the middleware and answered by the login handler.
        if (init.url === "/login") auth.login(request, response);
        else resolve({ passed: true, status: 200, headers });
      });
    });

  const bad = () => generateApiToken();
  return { auth, good, run, bad };
}

const read = { url: "/api/v1/meta" };
const login = (password: string) => ({
  method: "POST",
  url: "/login",
  body: { password },
});

describe("token failure limits", () => {
  it("one client's 100 bad tokens cannot lock out another client's login or any valid token", async () => {
    const { auth, good, run, bad } = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 100; i++) {
      statuses.push(
        (await run("203.0.113.1", { ...read, token: bad() })).status,
      );
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(95);
    // Only failures within the client's allowance reached the global budget.
    expect(
      (auth.limiter as unknown as { failures: unknown[] }).failures,
    ).toHaveLength(5);
    expect(auth.limiter.checkFailureBudget().ok).toBe(true);

    // Another client can still sign in...
    const other = await run("203.0.113.2", login(ADMIN_PW));
    expect(other.status).toBe(303);
    // ...and a valid token still works, from the abusive client and from others.
    expect((await run("203.0.113.1", { ...read, token: good })).passed).toBe(
      true,
    );
    expect((await run("203.0.113.2", { ...read, token: good })).passed).toBe(
      true,
    );
  });

  it("a valid token works while the global budget is spent; misses answer 429", async () => {
    const { auth, good, run, bad } = setup();
    const now = 1_000_000;
    auth.limiter = new LoginRateLimiter(5, 60_000, () => now, 10_000, 3);
    auth.tokenLimiter = new LoginRateLimiter(5, 60_000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(
        (await run(`198.51.100.${i}`, { ...read, token: bad() })).status,
      ).toBe(401);
    }
    expect(auth.limiter.checkFailureBudget().ok).toBe(false);
    // The lockout does not refuse a valid token...
    expect((await run("198.51.100.50", { ...read, token: good })).passed).toBe(
      true,
    );
    // ...but a miss, even from a fresh client, is a 429.
    const miss = await run("198.51.100.51", { ...read, token: bad() });
    expect(miss.status).toBe(429);
    expect(miss.headers.get("retry-after")).toBe("60");
    // And the global lockout still stops password logins.
    expect((await run("198.51.100.52", login(ADMIN_PW))).status).toBe(429);
  });

  it("the per-client 429 carries Retry-After and is per client", async () => {
    const { auth, run, bad } = setup();
    let now = 5_000_000;
    auth.tokenLimiter = new LoginRateLimiter(5, 60_000, () => now);
    for (let i = 0; i < 5; i++) {
      expect((await run("192.0.2.7", { ...read, token: bad() })).status).toBe(
        401,
      );
    }
    const limited = await run("192.0.2.7", { ...read, token: bad() });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await run("192.0.2.8", { ...read, token: bad() })).status).toBe(
      401,
    );
    now += 60_000;
    expect((await run("192.0.2.7", { ...read, token: bad() })).status).toBe(
      401,
    );
  });
});
