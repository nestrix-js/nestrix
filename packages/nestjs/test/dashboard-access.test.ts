import { createHash, randomBytes } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AccessDecision,
  ALLOW,
  checkAccess,
  DENY,
  decideTokenExchange,
  FORWARDING_HEADERS,
  isCrossSite,
  isLocalRequest,
  isLoopbackAddress,
  isLoopbackHost,
  NEED_TOKEN,
  type RawRequestLike,
  rawRequestOf,
} from "../src/dashboard/access.js";
import {
  cookieMatches,
  cookieName,
  createStartupToken,
  dashboardLinkLine,
  deriveCookieValue,
  getBearerToken,
  getCookieValues,
  getProcessStartupToken,
  getQueryTokens,
  MAX_CANDIDATES,
  matchesDigest,
  resetProcessStartupTokenForTests,
  serializeCookie,
  sha256,
} from "../src/dashboard/startup-token.js";
import { type ResolvedUi, resolveUi } from "../src/resolve-options.js";

const PORT = 3000;
const startup = createStartupToken(Buffer.alloc(32, 7));
const CONF_TOKEN = "c".repeat(40);

interface FakeOptions {
  remoteAddress?: unknown;
  localPort?: unknown;
  encrypted?: boolean;
  headers?: Record<string, unknown>;
  rawHeaders?: string[];
  url?: string;
  /** Wrap like Fastify: `{ raw: IncomingMessage-like }`. */
  fastify?: boolean;
}

/** A raw request as Node would build it: `headers` lower-cased, `rawHeaders` the wire list. */
function fake(o: FakeOptions = {}): RawRequestLike | { raw: RawRequestLike } {
  const headers: Record<string, unknown> = { host: "localhost:3000" };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  const rawHeaders =
    o.rawHeaders ??
    Object.entries(headers).flatMap(([k, v]) =>
      typeof v === "string" ? [k, v] : [],
    );
  const raw: RawRequestLike = {
    socket: {
      remoteAddress: "remoteAddress" in o ? o.remoteAddress : "127.0.0.1",
      localPort: "localPort" in o ? o.localPort : PORT,
      encrypted: o.encrypted,
    },
    headers,
    rawHeaders,
    url: o.url ?? "/_nestrix/",
  };
  return o.fastify ? { raw } : raw;
}

const auto = resolveUi("auto", {});
const autoNoStartup = resolveUi({ startupToken: false }, {});
const autoWithToken = resolveUi({ auth: { token: CONF_TOKEN } }, {});
const enabledToken = resolveUi(
  { enabled: true, auth: { token: CONF_TOKEN } },
  {
    NODE_ENV: "production",
  },
);
function enabledCustom(authorize: (r: unknown) => unknown): ResolvedUi {
  return resolveUi(
    { enabled: true, auth: { authorize: authorize as () => boolean } },
    { NODE_ENV: "production" },
  );
}
function autoCustom(authorize: (r: unknown) => unknown): ResolvedUi {
  return resolveUi({ auth: { authorize: authorize as () => boolean } }, {});
}

function startupCookie(port: unknown = PORT): string {
  return `${cookieName("startup", port)}=${deriveCookieValue("startup", startup.token)}`;
}
function tokenCookie(port: unknown = PORT): string {
  return `${cookieName("token", port)}=${deriveCookieValue("token", CONF_TOKEN)}`;
}
/** A request that passes every 'auto' check. */
function localWithCookie(o: FakeOptions = {}) {
  return fake({ ...o, headers: { cookie: startupCookie(), ...o.headers } });
}

async function access(req: unknown, ui: ResolvedUi): Promise<AccessDecision> {
  return checkAccess(req, ui, startup);
}

describe("isLoopbackAddress", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.2",
    "127.1.2.3",
    "127.255.255.255",
    "127.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:127.10.20.30",
    "::FFFF:127.0.0.1",
  ])("%s is loopback", (a) => {
    expect(isLoopbackAddress(a)).toBe(true);
  });

  it.each([
    "10.0.0.1",
    "192.168.1.10",
    "128.0.0.1",
    "126.255.255.255",
    "0.0.0.0",
    "127.0.0.256",
    "127.0.0",
    "127.1",
    "127.0.0.01",
    "0127.0.0.1",
    " 127.0.0.1",
    "127.0.0.1 ",
    "::2",
    "::",
    "0:0:0:0:0:0:0:1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:128.0.0.1",
    "::127.0.0.1",
    "fe80::1%lo0",
    "::1%1",
    "2001:db8::1",
    "localhost",
    "",
  ])("%j is not loopback", (a) => {
    expect(isLoopbackAddress(a)).toBe(false);
  });

  it.each([undefined, null, 2130706433, {}])("%j is not loopback", (a) => {
    expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "localhost:3000",
    "LOCALHOST:3000",
    "LocalHost",
    "127.0.0.1",
    "127.0.0.1:8080",
    "127.4.5.6:1",
    "[::1]",
    "[::1]:3000",
    "localhost:65535",
  ])("%s is loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });

  it.each([
    "",
    "evil.example",
    "evil.example:3000",
    "localhost.",
    "localhost.:3000",
    "app.localhost",
    "localhost.evil.example",
    "localhost:",
    "localhost:65536",
    "localhost:99999",
    "localhost:123456",
    "localhost:abc",
    "localhost:3000:4000",
    "user@localhost",
    "localhost/x",
    " localhost",
    "localhost ",
    "::1",
    "[::1",
    "[::1]:",
    "[0:0:0:0:0:0:0:1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "127.0.0.256",
    "127.1",
    "127.0.0.01",
    "128.0.0.1",
    "0.0.0.0",
  ])("%j is not loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });

  it.each([undefined, null, ["localhost"], 1])("%j is not loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("isLocalRequest", () => {
  it("a direct loopback request with a loopback Host and no forwarding header is local", () => {
    expect(isLocalRequest(fake() as RawRequestLike)).toBe(true);
    for (const remoteAddress of ["::1", "::ffff:127.0.0.1", "127.9.9.9"]) {
      expect(isLocalRequest(fake({ remoteAddress }) as RawRequestLike)).toBe(
        true,
      );
    }
  });

  it("a non-loopback peer is not local, whatever the headers say", () => {
    expect(
      isLocalRequest(fake({ remoteAddress: "203.0.113.9" }) as RawRequestLike),
    ).toBe(false);
    expect(
      isLocalRequest(
        fake({ remoteAddress: "::ffff:203.0.113.9" }) as RawRequestLike,
      ),
    ).toBe(false);
  });

  it("a missing socket or remote address is not local", () => {
    const r = fake() as { socket: unknown };
    expect(isLocalRequest({ ...r, socket: undefined } as RawRequestLike)).toBe(
      false,
    );
    expect(isLocalRequest({ ...r, socket: null } as RawRequestLike)).toBe(
      false,
    );
    expect(
      isLocalRequest(fake({ remoteAddress: undefined }) as RawRequestLike),
    ).toBe(false);
  });

  it.each([
    ["missing (HTTP/1.0)", undefined],
    ["empty", ""],
    ["foreign", "evil.example"],
    ["foreign with port", "evil.example:3000"],
    ["127.0.0.1 inside a foreign name", "127.0.0.1.evil.example"],
  ])("Host %s is not local", (_name, host) => {
    expect(isLocalRequest(fake({ headers: { host } }) as RawRequestLike)).toBe(
      false,
    );
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "localhost"])(
    "Host %s is local",
    (host) => {
      expect(
        isLocalRequest(fake({ headers: { host } }) as RawRequestLike),
      ).toBe(true);
    },
  );

  it.each([...FORWARDING_HEADERS])("%s alone makes it not local", (name) => {
    expect(
      isLocalRequest(
        fake({ headers: { [name]: "127.0.0.1" } }) as RawRequestLike,
      ),
    ).toBe(false);
  });

  it.each([...FORWARDING_HEADERS])(
    "%s with an empty value makes it not local",
    (name) => {
      expect(
        isLocalRequest(fake({ headers: { [name]: "" } }) as RawRequestLike),
      ).toBe(false);
    },
  );

  it.each([...FORWARDING_HEADERS])(
    "%s present only on the wire (rawHeaders, any case) makes it not local",
    (name) => {
      const upper = name.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase());
      const req = fake({
        rawHeaders: ["Host", "localhost:3000", upper, "1.2.3.4"],
      });
      expect(isLocalRequest(req as RawRequestLike)).toBe(false);
    },
  );

  it("a second, foreign Host line on the wire makes it not local (Node keeps only the first in headers)", () => {
    const req = fake({
      headers: { host: "localhost:3000" },
      rawHeaders: ["Host", "localhost:3000", "Host", "evil.example"],
    });
    expect(isLocalRequest(req as RawRequestLike)).toBe(false);
  });

  it("an HTTP/2 :authority that is not loopback makes it not local", () => {
    expect(
      isLocalRequest(
        fake({ headers: { ":authority": "evil.example" } }) as RawRequestLike,
      ),
    ).toBe(false);
    expect(
      isLocalRequest(
        fake({ headers: { ":authority": "localhost:3000" } }) as RawRequestLike,
      ),
    ).toBe(true);
  });

  it("an HTTP/2 request with :authority but no host header is not local", () => {
    expect(
      isLocalRequest(
        fake({
          headers: { host: undefined, ":authority": "localhost:3000" },
        }) as RawRequestLike,
      ),
    ).toBe(false);
  });

  it("an unrelated header (X-Forwarded-Port is not on the list) does not matter", () => {
    expect(
      isLocalRequest(
        fake({ headers: { "x-something": "1" } }) as RawRequestLike,
      ),
    ).toBe(true);
  });

  it("a request whose getters throw is not local, and nothing throws", () => {
    const hostile = {
      get socket(): never {
        throw new Error("boom");
      },
    };
    expect(isLocalRequest(hostile as unknown as RawRequestLike)).toBe(false);
    expect(isLocalRequest(undefined)).toBe(false);
  });
});

describe("isCrossSite", () => {
  it.each([
    ["cross-site", true],
    ["Cross-Site", true],
    [" cross-site ", true],
    ["same-origin, cross-site", true],
    ["same-origin", false],
    ["same-site", false],
    ["none", false],
    [undefined, false],
  ])("%j → %s", (value, expected) => {
    expect(
      isCrossSite(
        fake({ headers: { "sec-fetch-site": value } }) as RawRequestLike,
      ),
    ).toBe(expected);
  });
});

describe("rawRequestOf", () => {
  it("uses .raw when it looks like a request (Fastify), the request itself otherwise", () => {
    const raw = fake() as RawRequestLike;
    expect(rawRequestOf({ raw })).toBe(raw);
    expect(rawRequestOf(raw)).toBe(raw);
    const express = { ...raw, raw: "not a request" };
    expect(rawRequestOf(express)).toBe(express);
    expect(rawRequestOf(null)).toBeUndefined();
    expect(rawRequestOf("x")).toBeUndefined();
  });
});

describe("checkAccess: 'auto'", () => {
  it("allows a local request with this listener's startup cookie", async () => {
    expect(await access(localWithCookie(), auto)).toBe(ALLOW);
    expect(await access(localWithCookie({ fastify: true }), auto)).toBe(ALLOW);
  });

  it("a local request without the startup cookie gets NEED_TOKEN (403)", async () => {
    expect(await access(fake(), auto)).toBe(NEED_TOKEN);
  });

  it("a wrong, empty or other-port startup cookie gets NEED_TOKEN", async () => {
    const name = cookieName("startup", PORT);
    for (const cookie of [
      `${name}=wrong`,
      `${name}=`,
      `${name}=${startup.token}`, // the token itself is not the cookie value
      startupCookie(4000),
      `${name}=${deriveCookieValue("token", startup.token)}`,
    ]) {
      expect(await access(fake({ headers: { cookie } }), auto)).toBe(
        NEED_TOKEN,
      );
    }
  });

  it("the cookie from the app on port 4000 does not admit to the app on port 3000", async () => {
    const otherApp = createStartupToken(Buffer.alloc(32, 9));
    const cookie = `${cookieName("startup", 4000)}=${deriveCookieValue("startup", otherApp.token)}; ${cookieName("startup", PORT)}=x`;
    expect(await access(fake({ headers: { cookie } }), auto)).toBe(NEED_TOKEN);
  });

  it("a non-local request is DENY (404), not NEED_TOKEN, with or without the cookie", async () => {
    for (const o of [
      { remoteAddress: "10.0.0.1" },
      { headers: { host: "evil.example" } },
      { headers: { host: undefined } },
      { headers: { "x-forwarded-for": "1.2.3.4" } },
      { headers: { via: "1.1 nginx" } },
    ] satisfies FakeOptions[]) {
      expect(await access(fake(o), auto)).toBe(DENY);
      expect(await access(localWithCookie(o), auto)).toBe(DENY);
    }
  });

  it("startupToken: false admits a local request without a cookie, and still checks locality", async () => {
    expect(await access(fake(), autoNoStartup)).toBe(ALLOW);
    expect(
      await access(fake({ remoteAddress: "10.0.0.1" }), autoNoStartup),
    ).toBe(DENY);
  });

  it("the same-host proxy case (loopback peer, rewritten Host, no forwarding header) needs the cookie", async () => {
    const proxied = fake({ headers: { host: "127.0.0.1:3000" } });
    expect(await access(proxied, auto)).toBe(NEED_TOKEN);
    expect(await access(proxied, autoNoStartup)).toBe(ALLOW); // the documented limit
  });

  it("auth in 'auto' is checked in addition: token by Bearer or token cookie", async () => {
    expect(await access(localWithCookie(), autoWithToken)).toBe(DENY);
    expect(
      await access(
        localWithCookie({
          headers: { authorization: `Bearer ${CONF_TOKEN}` },
        }),
        autoWithToken,
      ),
    ).toBe(ALLOW);
    expect(
      await access(
        fake({ headers: { cookie: `${startupCookie()}; ${tokenCookie()}` } }),
        autoWithToken,
      ),
    ).toBe(ALLOW);
    // The token alone does not replace the startup cookie.
    expect(
      await access(
        fake({ headers: { authorization: `Bearer ${CONF_TOKEN}` } }),
        autoWithToken,
      ),
    ).toBe(NEED_TOKEN);
  });

  it("no startup token state where one is needed is DENY (fail closed)", async () => {
    expect(await checkAccess(localWithCookie(), auto, undefined)).toBe(DENY);
  });
});

describe("checkAccess: 'enabled'", () => {
  it("token auth needs no loopback: a remote, forwarded request with the Bearer token is allowed", async () => {
    const req = fake({
      remoteAddress: "203.0.113.9",
      headers: {
        host: "dash.example.com",
        "x-forwarded-for": "198.51.100.1",
        authorization: `Bearer ${CONF_TOKEN}`,
      },
    });
    expect(await access(req, enabledToken)).toBe(ALLOW);
  });

  it("token auth by cookie", async () => {
    expect(
      await access(
        fake({
          remoteAddress: "10.0.0.5",
          headers: { cookie: tokenCookie() },
        }),
        enabledToken,
      ),
    ).toBe(ALLOW);
  });

  it("no, wrong, short, long or empty token is DENY (404), never NEED_TOKEN", async () => {
    for (const authorization of [
      undefined,
      "Bearer wrong",
      `Bearer ${CONF_TOKEN.slice(1)}`,
      `Bearer ${CONF_TOKEN}x`,
      "Bearer ",
      "Bearer",
      `Basic ${CONF_TOKEN}`,
      CONF_TOKEN,
    ]) {
      expect(
        await access(fake({ headers: { authorization } }), enabledToken),
      ).toBe(DENY);
    }
  });

  it("the Bearer scheme is case-insensitive and tolerates extra whitespace", async () => {
    for (const authorization of [
      `bearer ${CONF_TOKEN}`,
      `BEARER  ${CONF_TOKEN}`,
      `Bearer\t${CONF_TOKEN} `,
    ]) {
      expect(
        await access(fake({ headers: { authorization } }), enabledToken),
      ).toBe(ALLOW);
    }
  });

  it("the startup token or startup cookie does not pass token auth", async () => {
    expect(
      await access(
        fake({
          headers: {
            authorization: `Bearer ${startup.token}`,
            cookie: startupCookie(),
          },
        }),
        enabledToken,
      ),
    ).toBe(DENY);
  });
});

describe("checkAccess: authorize", () => {
  it("only true allows", async () => {
    expect(
      await access(
        fake(),
        enabledCustom(() => true),
      ),
    ).toBe(ALLOW);
    expect(
      await access(
        fake(),
        enabledCustom(() => Promise.resolve(true)),
      ),
    ).toBe(ALLOW);
    for (const result of ["yes", 1, {}, "true", false, undefined, null]) {
      expect(
        await access(
          fake(),
          enabledCustom(() => result),
        ),
      ).toBe(DENY);
      expect(
        await access(
          fake(),
          enabledCustom(() => Promise.resolve(result)),
        ),
      ).toBe(DENY);
    }
  });

  it("a throw or a rejection denies, and checkAccess neither throws nor rejects", async () => {
    const throwing = enabledCustom(() => {
      throw new Error("authorize blew up");
    });
    const rejecting = enabledCustom(() => Promise.reject(new Error("no")));
    const badThenable = enabledCustom(() => ({
      // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the point of this test.
      then() {
        throw new Error("then threw");
      },
    }));
    await expect(access(fake(), throwing)).resolves.toBe(DENY);
    await expect(access(fake(), rejecting)).resolves.toBe(DENY);
    await expect(access(fake(), badThenable)).resolves.toBe(DENY);
  });

  it("receives the request the handler received (Fastify's wrapper, not .raw), with the auth object as this", async () => {
    const seen: unknown[] = [];
    const auth = {
      expected: "me",
      authorize(this: { expected: string }, req: unknown) {
        seen.push(req, this.expected);
        return true;
      },
    };
    const r = resolveUi({ enabled: true, auth }, { NODE_ENV: "production" });
    const req = fake({ fastify: true });
    expect(await access(req, r)).toBe(ALLOW);
    expect(seen[0]).toBe(req);
    expect(seen[1]).toBe("me");
  });

  it("is not called when a cheap check fails", async () => {
    const authorize = vi.fn(() => true);
    await access(
      fake({ headers: { "sec-fetch-site": "cross-site" } }),
      enabledCustom(authorize),
    );
    await access(fake({ remoteAddress: "10.0.0.1" }), autoCustom(authorize));
    await access(fake(), autoCustom(authorize)); // no startup cookie
    expect(authorize).not.toHaveBeenCalled();
    expect(await access(localWithCookie(), autoCustom(authorize))).toBe(ALLOW);
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});

describe("checkAccess: Sec-Fetch-Site and fail-closed", () => {
  const crossSite = { headers: { "sec-fetch-site": "cross-site" } };

  it.each<[string, ResolvedUi, () => unknown]>([
    ["auto", auto, () => localWithCookie(crossSite)],
    ["auto, startupToken false", autoNoStartup, () => fake(crossSite)],
    [
      "enabled, token",
      enabledToken,
      () =>
        fake({
          headers: {
            "sec-fetch-site": "cross-site",
            authorization: `Bearer ${CONF_TOKEN}`,
          },
        }),
    ],
    ["enabled, authorize", enabledCustom(() => true), () => fake(crossSite)],
  ])("cross-site is DENY in mode %s", async (_name, ui, req) => {
    expect(await access(req(), ui)).toBe(DENY);
  });

  it("same-site and same-origin are not denied by this rule", async () => {
    for (const v of ["same-site", "same-origin", "none"]) {
      expect(
        await access(
          localWithCookie({ headers: { "sec-fetch-site": v } }),
          auto,
        ),
      ).toBe(ALLOW);
    }
  });

  it("ui off is DENY", async () => {
    expect(await access(localWithCookie(), resolveUi(false, {}))).toBe(DENY);
  });

  it("a non-object request, or one whose getters throw, is DENY", async () => {
    expect(await access(undefined, autoNoStartup)).toBe(DENY);
    expect(await access("x", autoNoStartup)).toBe(DENY);
    const hostile = {
      get raw(): never {
        throw new Error("boom");
      },
    };
    await expect(access(hostile, autoNoStartup)).resolves.toBe(DENY);
    const hostileHeaders = {
      socket: { remoteAddress: "127.0.0.1" },
      get headers(): never {
        throw new Error("boom");
      },
    };
    await expect(access(hostileHeaders, enabledToken)).resolves.toBe(DENY);
  });
});

describe("token comparison", () => {
  const digest = sha256(CONF_TOKEN);

  it("right token matches", () => {
    expect(matchesDigest(CONF_TOKEN, digest)).toBe(true);
  });

  it.each([
    ["wrong", "d".repeat(40)],
    ["one character short", CONF_TOKEN.slice(1)],
    ["one character long", `${CONF_TOKEN}c`],
    ["much longer", CONF_TOKEN.repeat(100)],
    ["empty", ""],
  ])("%s does not match", (_name, candidate) => {
    expect(matchesDigest(candidate, digest)).toBe(false);
  });

  it("non-strings and malformed digests are false, not a throw", () => {
    expect(matchesDigest(undefined, digest)).toBe(false);
    expect(matchesDigest(["x"], digest)).toBe(false);
    expect(matchesDigest(CONF_TOKEN, Buffer.alloc(0))).toBe(false);
    expect(matchesDigest(CONF_TOKEN, Buffer.alloc(31))).toBe(false);
    expect(matchesDigest(CONF_TOKEN, "digest" as unknown as Buffer)).toBe(
      false,
    );
  });
});

describe("cookie parsing", () => {
  const name = "nestrix_session_3000";

  it.each<[string, unknown, string[]]>([
    ["single", `${name}=abc`, ["abc"]],
    ["among others", `a=1; ${name}=abc; b=2`, ["abc"]],
    ["no spaces", `a=1;${name}=abc;b=2`, ["abc"]],
    ["extra spaces and tabs", `a=1 ;\t ${name} = abc \t; b=2`, ["abc"]],
    ["quoted", `${name}="abc"`, ["abc"]],
    ["only one pair of quotes removed", `${name}=""abc""`, ['"abc"']],
    ["a lone quote is kept", `${name}="`, ['"']],
    ["duplicates, in order", `${name}=one; x=y; ${name}=two`, ["one", "two"]],
    ["value containing =", `${name}=a=b=`, ["a=b="]],
    ["empty value", `${name}=`, [""]],
    ["name is case-sensitive", `NESTRIX_SESSION_3000=abc`, []],
    ["prefix of another name", `x${name}=abc; ${name}x=def`, []],
    ["pair without =", `${name}; a=1`, []],
    ["empty header", "", []],
    ["not a string", 42, []],
    ["array of headers", ["a=1", `${name}=abc`, 5], ["abc"]],
  ])("%s", (_case, header, expected) => {
    expect(getCookieValues(header, name)).toEqual(expected);
  });

  it("has no cap on values: eight planted values before the real one still match", () => {
    const value = deriveCookieValue("startup", startup.token);
    const header = `${Array.from({ length: 8 }, (_, i) => `${name}=x${i}`).join("; ")}; ${name}=${value}`;
    expect(getCookieValues(header, name)).toHaveLength(9);
    expect(cookieMatches(header, name, startup.cookieDigest)).toBe(true);
  });

  it("any matching duplicate admits", () => {
    const value = deriveCookieValue("startup", startup.token);
    expect(
      cookieMatches(
        `${name}=stale; ${name}="${value}"; ${name}=other`,
        name,
        startup.cookieDigest,
      ),
    ).toBe(true);
    expect(
      cookieMatches(`${name}=stale; ${name}=other`, name, startup.cookieDigest),
    ).toBe(false);
  });

  it("a duplicate startup cookie with a stale value next to the right one admits through checkAccess", async () => {
    const n = cookieName("startup", PORT);
    const cookie = `${n}=stale; ${startupCookie()}`;
    expect(await access(fake({ headers: { cookie } }), auto)).toBe(ALLOW);
  });
});

describe("bearer and query parsing", () => {
  it.each<[unknown, string | undefined]>([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["Bearer   abc  ", "abc"],
    ["Bearer a b", "a b"],
    ["Bearer", undefined],
    ["Bearer ", undefined],
    ["Bearerabc", undefined],
    ["Basic abc", undefined],
    [undefined, undefined],
    [["Bearer abc"], undefined],
  ])("%j → %j", (header, expected) => {
    expect(getBearerToken(header)).toBe(expected);
  });

  it.each<[unknown, string[]]>([
    ["/_nestrix/auth?token=abc", ["abc"]],
    ["/_nestrix/auth?x=1&token=a%2Bb&token=c", ["a+b", "c"]],
    ["/_nestrix/auth", []],
    ["/_nestrix/auth?token=", [""]],
    ["http://evil.example/_nestrix/auth?token=abc", ["abc"]],
    [undefined, []],
  ])("%j → %j", (url, expected) => {
    expect(getQueryTokens(url)).toEqual(expected);
  });

  it(`reads at most ${MAX_CANDIDATES} token parameters`, () => {
    const url = `/a?${Array.from({ length: 50 }, (_, i) => `token=${i}`).join("&")}`;
    expect(getQueryTokens(url)).toHaveLength(MAX_CANDIDATES);
  });
});

describe("startup token", () => {
  it("is 32 random bytes as base64url (43 characters), different each time", () => {
    const a = createStartupToken();
    const b = createStartupToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.token, "base64url")).toHaveLength(32);
    expect(matchesDigest(a.token, a.tokenDigest)).toBe(true);
    expect(
      matchesDigest(deriveCookieValue("startup", a.token), a.cookieDigest),
    ).toBe(true);
  });

  it("refuses anything but 32 bytes", () => {
    expect(() => createStartupToken(Buffer.alloc(16))).toThrow();
    expect(() => createStartupToken(randomBytes(33))).toThrow();
  });

  it("one per process", () => {
    resetProcessStartupTokenForTests();
    const a = getProcessStartupToken();
    expect(getProcessStartupToken()).toBe(a);
    resetProcessStartupTokenForTests();
    expect(getProcessStartupToken().token).not.toBe(a.token);
  });
});

describe("cookie name and Set-Cookie", () => {
  it("differs by listener port and by kind, and is stable for one port", () => {
    expect(cookieName("startup", 3000)).toBe("nestrix_session_3000");
    expect(cookieName("startup", 4000)).toBe("nestrix_session_4000");
    expect(cookieName("token", 3000)).toBe("nestrix_auth_3000");
    for (const bad of [undefined, null, "3000", 0, -1, 70000, 1.5]) {
      expect(cookieName("startup", bad)).toBe("nestrix_session_0");
    }
  });

  it("is a session cookie: HttpOnly, SameSite=Strict, Path, no Max-Age or Expires; Secure only over TLS", () => {
    expect(serializeCookie("n", "v", "/_nestrix", false)).toBe(
      "n=v; Path=/_nestrix; HttpOnly; SameSite=Strict",
    );
    expect(serializeCookie("n", "v", "/_nestrix", true)).toBe(
      "n=v; Path=/_nestrix; HttpOnly; SameSite=Strict; Secure",
    );
  });
});

describe("token exchange", () => {
  const authUrl = (token: string) =>
    `/_nestrix/auth?token=${encodeURIComponent(token)}`;

  it("the right startup token sets this listener's cookie and redirects 303 to <path>/", async () => {
    const d = await decideTokenExchange(
      fake({ url: authUrl(startup.token) }),
      auto,
      startup,
    );
    expect(d).toEqual({
      outcome: "redirect",
      status: 303,
      location: "/_nestrix/",
      setCookie: `nestrix_session_3000=${deriveCookieValue("startup", startup.token)}; Path=/_nestrix; HttpOnly; SameSite=Strict`,
    });
  });

  it("round trip: the cookie it sets admits the next request; on another port it does not", async () => {
    const d = await decideTokenExchange(
      fake({ url: authUrl(startup.token) }),
      auto,
      startup,
    );
    if (d.outcome !== "redirect" || !d.setCookie) throw new Error("no cookie");
    const cookie = d.setCookie.split(";")[0] as string;
    expect(await access(fake({ headers: { cookie } }), auto)).toBe(ALLOW);
    expect(
      await access(fake({ localPort: 4000, headers: { cookie } }), auto),
    ).toBe(NEED_TOKEN);
  });

  it("uses the configured path in Path and Location", async () => {
    const ui = resolveUi({ path: "/ops/trace/" }, {});
    const d = await decideTokenExchange(
      fake({ url: `/ops/trace/auth?token=${startup.token}` }),
      ui,
      startup,
    );
    expect(d.outcome).toBe("redirect");
    if (d.outcome !== "redirect") return;
    expect(d.location).toBe("/ops/trace/");
    expect(d.setCookie).toContain("; Path=/ops/trace;");
  });

  it("adds Secure when the socket is TLS", async () => {
    const d = await decideTokenExchange(
      fake({ url: authUrl(startup.token), encrypted: true }),
      auto,
      startup,
    );
    expect(d.outcome === "redirect" && d.setCookie?.endsWith("; Secure")).toBe(
      true,
    );
  });

  it("'enabled' sets Secure on the auth cookie unless the request is local", async () => {
    const url = `/_nestrix/auth?token=${CONF_TOKEN}`;
    const remote = await decideTokenExchange(
      fake({
        url,
        remoteAddress: "10.0.0.5",
        headers: { host: "dash.example.com" },
      }),
      enabledToken,
      startup,
    );
    expect(
      remote.outcome === "redirect" && remote.setCookie?.endsWith("; Secure"),
    ).toBe(true);
    const local = await decideTokenExchange(
      fake({ url }),
      enabledToken,
      startup,
    );
    expect(local.outcome).toBe("redirect");
    expect(local.outcome === "redirect" && local.setCookie).not.toContain(
      "Secure",
    );
  });

  it("'auto' sets no Secure over plain HTTP", async () => {
    const d = await decideTokenExchange(
      fake({ url: `/_nestrix/auth?token=${CONF_TOKEN}` }),
      autoWithToken,
      startup,
    );
    expect(d.outcome).toBe("redirect");
    expect(d.outcome === "redirect" && d.setCookie).not.toContain("Secure");
  });

  it("the auth cookie value depends on a per-process salt, the startup cookie value does not", () => {
    const token = deriveCookieValue("token", CONF_TOKEN);
    // Not the unsalted derivation.
    expect(token).not.toBe(
      createHash("sha256")
        .update(`nestrix.dashboard.cookie.v1\0token\0${CONF_TOKEN}`)
        .digest("base64url"),
    );
    expect(deriveCookieValue("startup", startup.token)).toBe(
      createHash("sha256")
        .update(`nestrix.dashboard.cookie.v1\0startup\0${startup.token}`)
        .digest("base64url"),
    );
  });

  it("a wrong, empty or missing token in 'auto' gets NEED_TOKEN (the stale-link case)", async () => {
    for (const url of [
      authUrl("wrong"),
      authUrl(""),
      authUrl(startup.token.slice(1)),
      "/_nestrix/auth",
    ]) {
      expect(await decideTokenExchange(fake({ url }), auto, startup)).toBe(
        NEED_TOKEN,
      );
    }
  });

  it("the right token from a non-local or cross-site request is DENY, before the token is looked at", async () => {
    for (const o of [
      { remoteAddress: "10.0.0.1" },
      { headers: { host: "evil.example" } },
      { headers: { "x-forwarded-for": "1.2.3.4" } },
      { headers: { "sec-fetch-site": "cross-site" } },
    ] satisfies FakeOptions[]) {
      expect(
        await decideTokenExchange(
          fake({ ...o, url: authUrl(startup.token) }),
          auto,
          startup,
        ),
      ).toBe(DENY);
    }
  });

  it("several token parameters: any matching one is exchanged", async () => {
    const d = await decideTokenExchange(
      fake({ url: `/_nestrix/auth?token=bad&token=${startup.token}` }),
      auto,
      startup,
    );
    expect(d.outcome).toBe("redirect");
  });

  it("enabled with token auth: the configured token sets nestrix_auth_<port>, a wrong one is DENY", async () => {
    const remote = {
      remoteAddress: "203.0.113.9",
      headers: { host: "dash.example" },
    };
    const d = await decideTokenExchange(
      fake({ ...remote, url: authUrl(CONF_TOKEN) }),
      enabledToken,
      startup,
    );
    expect(d.outcome).toBe("redirect");
    if (d.outcome !== "redirect" || !d.setCookie) return;
    expect(d.setCookie.startsWith("nestrix_auth_3000=")).toBe(true);
    expect(d.setCookie).not.toContain(CONF_TOKEN);
    const cookie = d.setCookie.split(";")[0] as string;
    expect(
      await access(
        fake({ ...remote, headers: { ...remote.headers, cookie } }),
        enabledToken,
      ),
    ).toBe(ALLOW);

    expect(
      await decideTokenExchange(
        fake({ ...remote, url: authUrl("wrong") }),
        enabledToken,
        startup,
      ),
    ).toBe(DENY);
    // The startup token means nothing in 'enabled' mode.
    expect(
      await decideTokenExchange(
        fake({ ...remote, url: authUrl(startup.token) }),
        enabledToken,
        startup,
      ),
    ).toBe(DENY);
  });

  it("'auto' with token auth: each secret sets its own cookie; both are then needed", async () => {
    const s = await decideTokenExchange(
      fake({ url: authUrl(startup.token) }),
      autoWithToken,
      startup,
    );
    const t = await decideTokenExchange(
      fake({ url: authUrl(CONF_TOKEN) }),
      autoWithToken,
      startup,
    );
    if (s.outcome !== "redirect" || t.outcome !== "redirect")
      throw new Error("expected redirects");
    expect(s.setCookie?.startsWith("nestrix_session_3000=")).toBe(true);
    expect(t.setCookie?.startsWith("nestrix_auth_3000=")).toBe(true);
    const both = `${s.setCookie?.split(";")[0]}; ${t.setCookie?.split(";")[0]}`;
    expect(
      await access(fake({ headers: { cookie: both } }), autoWithToken),
    ).toBe(ALLOW);
  });

  it("nothing to exchange (startupToken false, no token auth): redirect without a cookie when access is allowed", async () => {
    expect(
      await decideTokenExchange(
        fake({ url: authUrl("anything") }),
        autoNoStartup,
        startup,
      ),
    ).toEqual({
      outcome: "redirect",
      status: 303,
      location: "/_nestrix/",
      setCookie: undefined,
    });
    expect(
      await decideTokenExchange(
        fake({ url: authUrl("x") }),
        enabledCustom(() => false),
        startup,
      ),
    ).toBe(DENY);
    expect(
      await decideTokenExchange(
        fake({ url: authUrl("x") }),
        enabledCustom(() => true),
        startup,
      ),
    ).toMatchObject({ outcome: "redirect", setCookie: undefined });
  });

  it("already holding the cookie and opening <path>/auth without a token redirects without a new cookie", async () => {
    expect(
      await decideTokenExchange(
        localWithCookie({ url: "/_nestrix/auth" }),
        auto,
        startup,
      ),
    ).toMatchObject({ outcome: "redirect", setCookie: undefined });
  });

  it("never throws or rejects", async () => {
    const hostile = {
      get raw(): never {
        throw new Error("boom");
      },
    };
    await expect(decideTokenExchange(hostile, auto, startup)).resolves.toBe(
      DENY,
    );
    await expect(
      decideTokenExchange(fake({ url: authUrl("x") }), auto, undefined),
    ).resolves.toBe(DENY);
    await expect(
      decideTokenExchange(fake(), resolveUi(false, {}), startup),
    ).resolves.toBe(DENY);
  });
});

describe("startup log line", () => {
  it("with a port and a token: the exchange link", () => {
    expect(
      dashboardLinkLine({ path: "/_nestrix", port: 3000, startupToken: "abc" }),
    ).toBe("Nestrix dashboard: http://localhost:3000/_nestrix/auth?token=abc");
  });

  it("with a port and no token: the dashboard link", () => {
    expect(
      dashboardLinkLine({
        path: "/_nestrix",
        port: 3000,
        startupToken: undefined,
      }),
    ).toBe("Nestrix dashboard: http://localhost:3000/_nestrix/");
  });

  it("without a listening server: the path, no token, and that the link needs one", () => {
    const line = dashboardLinkLine({
      path: "/_nestrix",
      port: undefined,
      startupToken: "abc",
    });
    expect(line).toContain("/_nestrix/");
    expect(line).toContain("needs a listening server");
    expect(line).not.toContain("abc");
    expect(
      dashboardLinkLine({ path: "/_nestrix", port: 0, startupToken: "abc" }),
    ).not.toContain("abc");
  });
});

/**
 * The same rules over real sockets, to check the fakes above match what Node 26 hands a handler.
 * P2-07 repeats this on the three Nest adapters.
 */
describe("isLocalRequest on a real node:http server", () => {
  let server: http.Server;
  let port: number;
  const seen: IncomingMessage[] = [];
  const localPorts: unknown[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req);
      localPorts.push(req.socket.localPort);
      res.end(isLocalRequest(req) ? "local" : "not-local");
    });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function raw(host: string, request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port }, () => socket.write(request));
      let out = "";
      socket.on("data", (d) => {
        out += d;
      });
      socket.on("end", () => resolve(out.slice(out.indexOf("\r\n\r\n") + 4)));
      socket.on("error", reject);
    });
  }

  const get = (headers: string) =>
    `GET /_nestrix/ HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`;

  it("IPv4 through a dual-stack listener (::ffff:127.0.0.1) and IPv6 (::1) are local", async () => {
    expect(await raw("127.0.0.1", get("Host: localhost\r\n"))).toBe("local");
    expect(seen.at(-1)?.socket.remoteAddress).toBe("::ffff:127.0.0.1");
    expect(await raw("::1", get(`Host: [::1]:${port}\r\n`))).toBe("local");
    expect(seen.at(-1)?.socket.remoteAddress).toBe("::1");
  });

  it("a second, foreign Host header is not local (Node keeps the first in headers)", async () => {
    expect(
      await raw("127.0.0.1", get("Host: localhost\r\nHost: evil.example\r\n")),
    ).toBe("not-local");
    expect(seen.at(-1)?.headers.host).toBe("localhost");
  });

  it("HTTP/1.0 without Host is not local", async () => {
    expect(await raw("127.0.0.1", "GET /_nestrix/ HTTP/1.0\r\n\r\n")).toBe(
      "not-local",
    );
  });

  it("an empty X-Forwarded-For is not local", async () => {
    expect(
      await raw("127.0.0.1", get("Host: localhost\r\nX-Forwarded-For:\r\n")),
    ).toBe("not-local");
  });

  it("the socket's localPort is the listener's port while the request is open (the cookie name's input)", async () => {
    await raw("127.0.0.1", get("Host: localhost\r\n"));
    expect(localPorts.at(-1)).toBe(port);
    // Read after the connection closed it is gone: a handler running after an abort gets port 0,
    // a cookie name that matches nothing, so it fails closed.
    expect(seen.at(-1)?.socket.localPort).toBeUndefined();
  });
});
