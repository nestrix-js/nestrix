// The admin login of the standalone server (backlog P5-04): the form, POST /login, cookies,
// Origin, rate limit, logout.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminAuth } from "../../src/auth/admin-auth.js";
import { LOGIN_CSP } from "../../src/auth/http.js";
import { LoginRateLimiter } from "../../src/auth/login-rate-limit.js";
import { SESSION_TTL_SECONDS } from "../../src/auth/session.js";
import type { TestServer } from "../ingest/helpers.js";
import {
  ADMIN_PW,
  cookieName,
  cookiePair,
  corsHeaders,
  originOf,
  postLogin,
  rawRequest,
  startAuthServer,
} from "./helpers.js";

let server: TestServer;
let auth: AdminAuth;

beforeAll(async () => {
  server = await startAuthServer();
  auth = server.app.get(AdminAuth);
});
afterAll(async () => {
  await server?.close();
});
beforeEach(() => {
  auth.limiter = new LoginRateLimiter();
});

describe("GET /login", () => {
  it("serves a form with a strict CSP and no inline script or style", async () => {
    const res = await fetch(`${server.baseUrl}/login`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(LOGIN_CSP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/login">');
    expect(html).toContain('type="password"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  it("serves its stylesheet without a session", async () => {
    const res = await fetch(`${server.baseUrl}/login.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("redirects to / when already signed in", async () => {
    const login = await postLogin(server.baseUrl, ADMIN_PW);
    const cookie = cookiePair(login.headers.get("set-cookie"));
    const res = await fetch(`${server.baseUrl}/login`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("POST /login", () => {
  it("signs in with the right password: 303 to / and a strict session cookie", async () => {
    const res = await postLogin(server.baseUrl, ADMIN_PW);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(
      new RegExp(`^${cookieName()}=v1\\.\\d+\\.[\\w-]{22}\\.[\\w-]{43};`),
    );
    expect(setCookie).toContain("; Path=/");
    expect(setCookie).toContain(`; Max-Age=${SESSION_TTL_SECONDS}`);
    expect(setCookie).toContain("; HttpOnly");
    expect(setCookie).toContain("; SameSite=Strict");
    // 127.0.0.1 over plain HTTP: the one case without Secure.
    expect(setCookie).not.toContain("Secure");
    expect(corsHeaders(res.headers)).toEqual([]);

    const page = await fetch(`${server.baseUrl}/`, {
      headers: { cookie: cookiePair(setCookie) },
      redirect: "manual",
    });
    expect(page.status).toBe(200);
  });

  it("sets Secure when the request is not loopback plain HTTP", async () => {
    const body = new URLSearchParams({ password: ADMIN_PW }).toString();
    const form = "application/x-www-form-urlencoded";
    const remote = await rawRequest(
      server.baseUrl,
      "POST",
      "/login",
      {
        host: "nestrix.example",
        origin: "https://nestrix.example",
        "content-type": form,
      },
      body,
    );
    expect(remote.status).toBe(303);
    expect(String(remote.headers["set-cookie"])).toContain("; Secure");

    const forwarded = await rawRequest(
      server.baseUrl,
      "POST",
      "/login",
      {
        origin: originOf(server.baseUrl),
        "x-forwarded-proto": "https",
        "content-type": form,
      },
      body,
    );
    expect(forwarded.status).toBe(303);
    expect(String(forwarded.headers["set-cookie"])).toContain("; Secure");
  });

  it("refuses a wrong, missing or repeated password with 401 and no cookie", async () => {
    const wrong = await postLogin(server.baseUrl, `${ADMIN_PW}x`);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(wrong.headers.get("content-security-policy")).toBe(LOGIN_CSP);
    expect(await wrong.text()).toContain("Incorrect password.");

    const empty = await postLogin(server.baseUrl, "");
    expect(empty.status).toBe(401);

    const none = await fetch(`${server.baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: originOf(server.baseUrl),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "other=1",
    });
    expect(none.status).toBe(401);

    const twice = await fetch(`${server.baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: originOf(server.baseUrl),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `password=${ADMIN_PW}&password=${ADMIN_PW}`,
    });
    expect(twice.status).toBe(401);
    expect(twice.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a request whose Origin does not match the Host, before any password check", async () => {
    const base = server.baseUrl;
    const port = new URL(base).port;
    const badOrigins: Array<string | undefined> = [
      undefined,
      "null",
      "http://evil.example",
      `http://127.0.0.1:${Number(port) + 1}`,
      `http://localhost:${port}`,
      `${originOf(base)}/login`,
      `http://user@127.0.0.1:${port}`,
      `ftp://127.0.0.1:${port}`,
    ];
    for (const origin of badOrigins) {
      auth.limiter = new LoginRateLimiter();
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (origin !== undefined) headers.origin = origin;
      const res = await rawRequest(
        base,
        "POST",
        "/login",
        headers,
        new URLSearchParams({ password: ADMIN_PW }).toString(),
      );
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers["set-cookie"], String(origin)).toBeUndefined();
    }
  });

  it("refuses two Host headers even when the first matches Origin", async () => {
    const res = await rawRequest(
      server.baseUrl,
      "POST",
      "/login",
      [
        "Host",
        new URL(server.baseUrl).host,
        "Host",
        "evil.example",
        "Origin",
        originOf(server.baseUrl),
        "Content-Type",
        "application/x-www-form-urlencoded",
      ],
      new URLSearchParams({ password: ADMIN_PW }).toString(),
    );
    // Node itself may reject the duplicate (400); either way no session is issued.
    expect([400, 403]).toContain(res.status);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a cross-site request (Sec-Fetch-Site) with 403", async () => {
    const res = await rawRequest(
      server.baseUrl,
      "POST",
      "/login",
      {
        origin: originOf(server.baseUrl),
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      new URLSearchParams({ password: ADMIN_PW }).toString(),
    );
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("allows 5 attempts per minute per client, then 429 with Retry-After, even for the right password", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await postLogin(server.baseUrl, `wrong-${i}-xxxxxxxxxxxx`);
      expect(res.status).toBe(401);
    }
    const limited = await postLogin(server.baseUrl, ADMIN_PW);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(limited.headers.get("set-cookie")).toBeNull();
    expect(await limited.text()).toContain("Too many attempts");
  });
});

describe("POST /logout", () => {
  it("clears the cookie and ends the session server-side", async () => {
    const login = await postLogin(server.baseUrl, ADMIN_PW);
    const cookie = cookiePair(login.headers.get("set-cookie"));

    const res = await fetch(`${server.baseUrl}/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: originOf(server.baseUrl) },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toMatch(new RegExp(`^${cookieName()}=;`));
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Strict");

    // The old cookie value no longer works, although it has not expired.
    const after = await fetch(`${server.baseUrl}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toBe("/login");
  });

  it("refuses a logout without a matching Origin and keeps the session", async () => {
    const login = await postLogin(server.baseUrl, ADMIN_PW);
    const cookie = cookiePair(login.headers.get("set-cookie"));
    const res = await rawRequest(server.baseUrl, "POST", "/logout", {
      cookie,
      origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const still = await fetch(`${server.baseUrl}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(still.status).toBe(200);
  });

  it("has no GET form (a link cannot sign the admin out)", async () => {
    const login = await postLogin(server.baseUrl, ADMIN_PW);
    const cookie = cookiePair(login.headers.get("set-cookie"));
    const res = await fetch(`${server.baseUrl}/logout`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    const still = await fetch(`${server.baseUrl}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(still.status).toBe(200);
  });
});
