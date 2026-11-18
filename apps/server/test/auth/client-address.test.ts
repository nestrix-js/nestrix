/**
 * The client address the login limiter keys on (issue #31, D-96): `NESTRIX_TRUSTED_PROXIES`
 * parsing, and `X-Forwarded-For` read only from a trusted peer, right to left, IPv4 and IPv6.
 * The last block drives `AdminAuth`'s `/login` with IPv6 socket peers (this container has no
 * IPv6 loopback, so they are given as socket addresses).
 */
import "reflect-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { AdminAuth } from "../../src/auth/admin-auth.js";
import {
  clientAddressOf,
  normalizeAddress,
  parseTrustedProxies,
  type TrustedProxies,
} from "../../src/auth/client-address.js";
import { LoginRateLimiter } from "../../src/auth/login-rate-limit.js";
import { loadConfig } from "../../src/config.js";
import { testConfig } from "../ingest/helpers.js";
import { ADMIN_PW, SESSION_SECRET } from "./helpers.js";

function trusted(text: string): TrustedProxies {
  const result = parseTrustedProxies(text);
  if (!result.ok || result.value === undefined)
    throw new Error(`not parsed: ${text}`);
  return result.value;
}

/** A request from `peer` with the given `X-Forwarded-For` lines. */
function req(peer: string | undefined, ...xff: string[]): IncomingMessage {
  const rawHeaders: string[] = ["Host", "nestrix.example"];
  for (const line of xff) rawHeaders.push("X-Forwarded-For", line);
  return {
    rawHeaders,
    headers: { host: "nestrix.example" },
    socket: { remoteAddress: peer },
  } as unknown as IncomingMessage;
}

describe("parseTrustedProxies", () => {
  it("is off when unset or blank", () => {
    expect(parseTrustedProxies(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parseTrustedProxies("  ")).toEqual({ ok: true, value: undefined });
    expect(parseTrustedProxies(" , ")).toEqual({ ok: true, value: undefined });
  });

  it("accepts IPv4 and IPv6 CIDRs and single addresses", () => {
    const t = trusted(
      " 10.0.0.0/8, 192.168.1.7 ,2001:db8::/32, ::1, fd00::/8 ",
    );
    expect(t.entries).toEqual([
      "10.0.0.0/8",
      "192.168.1.7",
      "2001:db8::/32",
      "::1",
      "fd00::/8",
    ]);
    expect(t.list.check("10.200.0.1", "ipv4")).toBe(true);
    expect(t.list.check("192.168.1.7", "ipv4")).toBe(true);
    expect(t.list.check("192.168.1.8", "ipv4")).toBe(false);
    expect(t.list.check("2001:db8:ffff::1", "ipv6")).toBe(true);
    expect(t.list.check("::1", "ipv6")).toBe(true);
    expect(t.list.check("::2", "ipv6")).toBe(false);
  });

  it("reports every invalid entry; one makes the whole value an error", () => {
    const result = parseTrustedProxies(
      "10.0.0.0/8, 10.0.0.0/33, 2001:db8::/129, example.com, 10.0.0.0/, 10.0.0.0/8x, fe80::1%eth0, 1.2.3, /8",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(8);
    for (const e of result.errors)
      expect(e).toMatch(/^NESTRIX_TRUSTED_PROXIES: /);
  });

  it("is a configuration error in loadConfig, and parsed into the config", () => {
    const bad = loadConfig({
      DATABASE_URL: "postgres://localhost/nestrix",
      NESTRIX_INGEST_AUTH: "none",
      NESTRIX_TRUSTED_PROXIES: "10.0.0.0/8,not-an-ip",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.errors.some((e) => e.includes('"not-an-ip"'))).toBe(true);
    const good = loadConfig({
      DATABASE_URL: "postgres://localhost/nestrix",
      NESTRIX_INGEST_AUTH: "none",
      NESTRIX_TRUSTED_PROXIES: "10.0.0.0/8",
    });
    expect(good.ok && good.config.trustedProxies?.entries).toEqual([
      "10.0.0.0/8",
    ]);
    const unset = loadConfig({
      DATABASE_URL: "postgres://localhost/nestrix",
      NESTRIX_INGEST_AUTH: "none",
    });
    expect(unset.ok && unset.config.trustedProxies).toBeUndefined();
  });
});

describe("normalizeAddress", () => {
  it("lower-cases, drops a zone, and compares IPv4-mapped IPv6 as IPv4", () => {
    expect(normalizeAddress("::FFFF:10.0.0.1")).toEqual({
      address: "10.0.0.1",
      family: "ipv4",
    });
    expect(normalizeAddress("FE80::1%eth0")).toEqual({
      address: "fe80::1",
      family: "ipv6",
    });
    expect(normalizeAddress("unknown")).toBeUndefined();
    expect(normalizeAddress(undefined)).toBeUndefined();
  });
});

describe("clientAddressOf", () => {
  const proxies = trusted("10.0.0.0/8, 2001:db8:ffff::/48");

  it("without trusted proxies, is the socket peer and ignores X-Forwarded-For", () => {
    expect(clientAddressOf(req("198.51.100.7", "203.0.113.1"), undefined)).toBe(
      "198.51.100.7",
    );
    expect(clientAddressOf(req("::ffff:198.51.100.7"), undefined)).toBe(
      "198.51.100.7",
    );
  });

  it("ignores a spoofed X-Forwarded-For from a peer that is not trusted", () => {
    expect(
      clientAddressOf(req("198.51.100.7", "203.0.113.1, 10.0.0.2"), proxies),
    ).toBe("198.51.100.7");
    expect(clientAddressOf(req("2001:db8:1::7", "203.0.113.1"), proxies)).toBe(
      "2001:db8:1::7",
    );
  });

  it("from a trusted peer, takes the rightmost entry that is not a trusted proxy", () => {
    // The client prepended a fake entry; the trusted proxies appended the real ones.
    expect(
      clientAddressOf(
        req("10.0.0.1", "1.1.1.1, 203.0.113.9, 10.0.0.5, 10.1.2.3"),
        proxies,
      ),
    ).toBe("203.0.113.9");
    // Mapped IPv4 peer (dual-stack socket).
    expect(
      clientAddressOf(req("::ffff:10.0.0.1", "203.0.113.9"), proxies),
    ).toBe("203.0.113.9");
    // No header from a trusted peer: the peer itself.
    expect(clientAddressOf(req("10.0.0.1"), proxies)).toBe("10.0.0.1");
  });

  it("reads every X-Forwarded-For line in order", () => {
    expect(
      clientAddressOf(
        req("10.0.0.1", "203.0.113.1", "203.0.113.2, 10.0.0.9"),
        proxies,
      ),
    ).toBe("203.0.113.2");
  });

  it("stops at an entry that is not an address and keeps the last trusted hop", () => {
    expect(
      clientAddressOf(
        req("10.0.0.1", "203.0.113.1, unknown, 10.0.0.7"),
        proxies,
      ),
    ).toBe("10.0.0.7");
    expect(clientAddressOf(req("10.0.0.1", "garbage"), proxies)).toBe(
      "10.0.0.1",
    );
  });

  it("when every hop is trusted, the leftmost one is the client", () => {
    expect(
      clientAddressOf(req("10.0.0.1", "10.9.9.9, 10.0.0.2"), proxies),
    ).toBe("10.9.9.9");
  });

  it("handles IPv6 peers and entries, with brackets and ports", () => {
    expect(
      clientAddressOf(req("2001:db8:ffff::1", "2001:DB8:1:2::99"), proxies),
    ).toBe("2001:db8:1:2::99");
    expect(
      clientAddressOf(
        req("2001:db8:ffff::1", "[2001:db8:1:2::99]:4711"),
        proxies,
      ),
    ).toBe("2001:db8:1:2::99");
    expect(clientAddressOf(req("10.0.0.1", "203.0.113.4:5555"), proxies)).toBe(
      "203.0.113.4",
    );
    expect(
      clientAddressOf(
        req("10.0.0.1", "2001:db8:1::5, 2001:db8:ffff::2"),
        proxies,
      ),
    ).toBe("2001:db8:1::5");
  });

  it("never throws", () => {
    const broken = {
      get rawHeaders(): never {
        throw new Error("injected fault");
      },
      socket: { remoteAddress: "10.0.0.1" },
    } as unknown as IncomingMessage;
    expect(clientAddressOf(broken, proxies)).toBe("10.0.0.1");
    expect(clientAddressOf({} as IncomingMessage, proxies)).toBeUndefined();
  });
});

describe("AdminAuth's /login limiter behind an IPv6 proxy", () => {
  function setup(env: Record<string, string>) {
    const auth = new AdminAuth(
      testConfig({
        NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
        NESTRIX_SESSION_SECRET: SESSION_SECRET,
        ...env,
      }),
    );
    auth.limiter = new LoginRateLimiter();
    const attempt = (peer: string, xff?: string): Promise<number> =>
      new Promise((resolve) => {
        const response = {
          statusCode: 200,
          headersSent: false,
          writableEnded: false,
          destroyed: false,
          setHeader: () => undefined,
          getHeaderNames: () => [],
          removeHeader: () => undefined,
          end() {
            resolve(response.statusCode);
          },
        } as unknown as ServerResponse;
        const rawHeaders = ["Host", "localhost", "Origin", "http://localhost"];
        if (xff !== undefined) rawHeaders.push("X-Forwarded-For", xff);
        const request = {
          method: "POST",
          url: "/login",
          headers: { host: "localhost", origin: "http://localhost" },
          rawHeaders,
          socket: { remoteAddress: peer },
          body: { password: "wrong-password-x" },
        } as unknown as IncomingMessage;
        void auth.login(request, response);
      });
    return attempt;
  }

  it("keys on the forwarded IPv6 /64 only when the IPv6 peer is trusted", async () => {
    const attempt = setup({ NESTRIX_TRUSTED_PROXIES: "2001:db8:ffff::/48" });
    for (let i = 1; i <= 5; i++) {
      expect(await attempt("2001:db8:ffff::1", `2001:db8:1:2::${i}`)).toBe(401);
    }
    // Same /64 behind the proxy: limited.
    expect(await attempt("2001:db8:ffff::1", "2001:db8:1:2::99")).toBe(429);
    // Another /64 behind the same proxy: its own limit.
    expect(await attempt("2001:db8:ffff::1", "2001:db8:1:3::1")).toBe(401);
    // An untrusted IPv6 peer cannot shed its limit with a forged header.
    for (let i = 0; i < 5; i++) {
      expect(await attempt("2001:db8:9:9::1", `2001:db8:7:${i}::1`)).toBe(401);
    }
    expect(await attempt("2001:db8:9:9::2", "2001:db8:7:77::1")).toBe(429);
  });

  it("without NESTRIX_TRUSTED_PROXIES every visitor of the proxy shares one limit", async () => {
    const attempt = setup({});
    for (let i = 1; i <= 5; i++) {
      expect(await attempt("2001:db8:ffff::1", `2001:db8:1:${i}::1`)).toBe(401);
    }
    expect(await attempt("2001:db8:ffff::1", "2001:db8:1:99::1")).toBe(429);
  });
});
