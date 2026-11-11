import { describe, expect, it } from "vitest";
import {
  clientKey,
  LoginRateLimiter,
} from "../../src/auth/login-rate-limit.js";

describe("LoginRateLimiter", () => {
  it("allows 5 attempts per sliding minute per client", () => {
    let now = 1_000_000;
    const limiter = new LoginRateLimiter(5, 60_000, () => now);
    for (let i = 0; i < 5; i++) expect(limiter.take("a").ok).toBe(true);
    const refused = limiter.take("a");
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(limiter.take("b").ok).toBe(true); // another client is unaffected
    now += 30_000;
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 30 });
    now += 30_000; // the five attempts leave the window together
    for (let i = 0; i < 5; i++) expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  it("does not let refused attempts extend the window", () => {
    let now = 0;
    const limiter = new LoginRateLimiter(2, 60_000, () => now);
    limiter.take("a");
    limiter.take("a");
    for (let i = 0; i < 50; i++) {
      now += 1000;
      limiter.take("a");
    }
    now = 60_000;
    expect(limiter.take("a").ok).toBe(true);
  });

  it("keeps at most maxClients entries, forgetting the least recently seen", () => {
    const limiter = new LoginRateLimiter(1, 60_000, () => 0, 3);
    for (const k of ["a", "b", "c", "d"]) limiter.take(k);
    expect(limiter.size).toBe(3);
    expect(limiter.take("a").ok).toBe(true); // "a" was forgotten
    expect(limiter.take("d").ok).toBe(false);
  });
});

describe("clientKey", () => {
  it("keys IPv4 by address, IPv4-mapped IPv6 as IPv4, IPv6 by /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe(
      "2001:db8:1:2::/64",
    );
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");
  });
});
