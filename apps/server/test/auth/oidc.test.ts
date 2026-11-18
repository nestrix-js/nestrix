/**
 * The OIDC relying party's checks one by one (issue #34, D-104): ID token signature, algorithm,
 * key choice and claims; discovery; the response caps; PKCE; the role mapping; the signed user
 * session and pending sign-in tokens; the configuration. The whole flow against a provider is in
 * oidc-flow.test.ts.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { startupMessages } from "../../src/auth/admin-auth.js";
import {
  claimValues,
  OidcClient,
  OidcError,
  parseJwks,
  parseMetadata,
  pkceChallenge,
  roleFor,
  safeEqual,
  verifyIdToken,
} from "../../src/auth/oidc.js";
import {
  oidcSessionKey,
  pendingKey,
  signPending,
  signUserSession,
  verifyPending,
  verifyUserSession,
} from "../../src/auth/session.js";
import { loadConfig, type OidcConfig } from "../../src/config.js";
import { rsaKey, signJwt } from "./fake-idp.js";

const ISSUER = "https://idp.example";
const CLIENT = "nestrix";
const NONCE = "n".repeat(43);
const NOW = 1_800_000_000;

const rsa = rsaKey();
const other = rsaKey();
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwk(pub: KeyObject, extra: Record<string, unknown> = {}) {
  return { ...pub.export({ format: "jwk" }), ...extra };
}

const keys = parseJwks({
  keys: [
    jwk(rsa.pub, { kid: "rsa", use: "sig" }),
    jwk(ec.publicKey, { kid: "ec" }),
  ],
});

function payload(over: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: CLIENT,
    sub: "u1",
    iat: NOW,
    exp: NOW + 300,
    nonce: NONCE,
    ...over,
  };
}

function token(
  over: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: "RS256", kid: "rsa" },
  key: KeyObject = rsa.priv,
) {
  return signJwt(header, payload(over), key);
}

const options = (over: Partial<Parameters<typeof verifyIdToken>[1]> = {}) => ({
  issuer: ISSUER,
  clientId: CLIENT,
  nonce: NONCE,
  nowSeconds: NOW,
  keys: async () => keys,
  refreshKeys: async () => keys,
  ...over,
});

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "accepted";
  } catch (error) {
    if (error instanceof OidcError) return error.reason;
    throw error;
  }
}

describe("verifyIdToken", () => {
  it("accepts a valid RS256 token and returns cleaned claims", async () => {
    const claims = await verifyIdToken(
      token({ email: "a@example.com\u0007", name: " Ada ", groups: ["g"] }),
      options(),
    );
    expect(claims.sub).toBe("u1");
    expect(claims.email).toBe("a@example.com");
    expect(claims.name).toBe("Ada");
    expect(claims.raw.groups).toEqual(["g"]);
  });

  it("accepts ES256 and PS256 tokens", async () => {
    const es = signJwt({ alg: "ES256", kid: "ec" }, payload(), ec.privateKey);
    expect((await verifyIdToken(es, options())).sub).toBe("u1");
    const ps = signJwt({ alg: "PS256", kid: "rsa" }, payload(), rsa.priv);
    expect((await verifyIdToken(ps, options())).sub).toBe("u1");
  });

  it("refuses alg none, HMAC (also keyed with the public key) and unknown algorithms", async () => {
    const [h, p] = token().split(".");
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${p}.`;
    expect(await reason(verifyIdToken(none, options()))).toBe("id_token_alg");
    const noneSigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${p}.AAAA`;
    expect(await reason(verifyIdToken(noneSigned, options()))).toBe(
      "id_token_alg",
    );
    const { createHmac } = await import("node:crypto");
    const hsHeader = Buffer.from('{"alg":"HS256","kid":"rsa"}').toString(
      "base64url",
    );
    const pem = rsa.pub.export({ format: "pem", type: "spki" });
    const hsSig = createHmac("sha256", pem)
      .update(`${hsHeader}.${p}`)
      .digest("base64url");
    expect(
      await reason(verifyIdToken(`${hsHeader}.${p}.${hsSig}`, options())),
    ).toBe("id_token_alg");
    expect(h).toBeDefined();
  });

  it("refuses a DER-encoded ES256 signature, and an ES256 header with a P-384 key", async () => {
    const input = signJwt({ alg: "ES256", kid: "ec" }, payload(), ec.privateKey)
      .split(".")
      .slice(0, 2)
      .join(".");
    const der = sign("sha256", Buffer.from(input), ec.privateKey);
    expect(
      await reason(
        verifyIdToken(`${input}.${der.toString("base64url")}`, options()),
      ),
    ).toBe("id_token_signature");
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const p384Keys = parseJwks({
      keys: [jwk(p384.publicKey, { kid: "p384" })],
    });
    const wrongCurve = signJwt(
      { alg: "ES256", kid: "p384" },
      payload(),
      p384.privateKey,
    );
    expect(
      await reason(
        verifyIdToken(
          wrongCurve,
          options({
            keys: async () => p384Keys,
            refreshKeys: async () => p384Keys,
          }),
        ),
      ),
    ).toBe("id_token_key");
  });

  it.each(["__proto__", "constructor", "toString"])(
    "refuses the algorithm %s at the alg check, without fetching keys again",
    async (alg) => {
      const [, p, sig] = token().split(".");
      const header = Buffer.from(JSON.stringify({ alg, kid: "rsa" })).toString(
        "base64url",
      );
      const refresh = vi.fn(async () => keys);
      expect(
        await reason(
          verifyIdToken(
            `${header}.${p}.${sig}`,
            options({ refreshKeys: refresh }),
          ),
        ),
      ).toBe("id_token_alg");
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it("refuses a token signed by another key, and a changed payload", async () => {
    expect(
      await reason(verifyIdToken(token({}, undefined, other.priv), options())),
    ).toBe("id_token_signature");
    const [h, , s] = token().split(".");
    const forged = Buffer.from(
      JSON.stringify(payload({ sub: "admin" })),
    ).toString("base64url");
    expect(await reason(verifyIdToken(`${h}.${forged}.${s}`, options()))).toBe(
      "id_token_signature",
    );
  });

  it("refuses a key of another type or algorithm, and an unknown kid after one refresh", async () => {
    // RS256 header naming the EC key.
    expect(
      await reason(
        verifyIdToken(token({}, { alg: "RS256", kid: "ec" }), options()),
      ),
    ).toBe("id_token_key");
    const pinned = parseJwks({
      keys: [jwk(rsa.pub, { kid: "rsa", alg: "RS512" })],
    });
    expect(
      await reason(
        verifyIdToken(
          token(),
          options({
            keys: async () => pinned,
            refreshKeys: async () => pinned,
          }),
        ),
      ),
    ).toBe("id_token_key");
    const refresh = vi.fn(async () => keys);
    expect(
      await reason(
        verifyIdToken(
          token({}, { alg: "RS256", kid: "gone" }),
          options({ refreshKeys: refresh }),
        ),
      ),
    ).toBe("id_token_key");
    expect(refresh).toHaveBeenCalledTimes(1);
    // A rotated key found by the refresh is used.
    const rotated = parseJwks({ keys: [jwk(other.pub, { kid: "new" })] });
    const claims = await verifyIdToken(
      token({}, { alg: "RS256", kid: "new" }, other.priv),
      options({ refreshKeys: async () => rotated }),
    );
    expect(claims.sub).toBe("u1");
  });

  it("without a kid, uses the only key that fits and refuses when several fit", async () => {
    const one = parseJwks({ keys: [jwk(rsa.pub)] });
    const two = parseJwks({ keys: [jwk(rsa.pub), jwk(other.pub)] });
    const t = token({}, { alg: "RS256" });
    expect(
      (await verifyIdToken(t, options({ keys: async () => one }))).sub,
    ).toBe("u1");
    expect(
      await reason(
        verifyIdToken(
          t,
          options({ keys: async () => two, refreshKeys: async () => two }),
        ),
      ),
    ).toBe("id_token_key");
  });

  it.each([
    ["id_token_iss", { iss: "https://idp.example/" }],
    ["id_token_iss", { iss: undefined }],
    ["id_token_aud", { aud: "someone-else" }],
    ["id_token_aud", { aud: [1, CLIENT] }],
    ["id_token_azp", { aud: [CLIENT, "api"] }],
    ["id_token_azp", { azp: "someone-else" }],
    ["id_token_exp", { exp: NOW - 61 }],
    ["id_token_exp", { exp: "never" }],
    ["id_token_iat", { iat: NOW + 120 }],
    ["id_token_iat", { iat: NOW - 3600 }],
    ["id_token_iat", { iat: undefined }],
    ["id_token_nbf", { nbf: NOW + 120 }],
    ["id_token_nonce", { nonce: "x".repeat(43) }],
    ["id_token_nonce", { nonce: undefined }],
    ["id_token_sub", { sub: "" }],
    ["id_token_sub", { sub: 42 }],
  ])("refuses with %s: %j", async (expected, over) => {
    expect(await reason(verifyIdToken(token(over), options()))).toBe(expected);
  });

  it("accepts several audiences with azp equal to the client, and 60 s of skew", async () => {
    const claims = await verifyIdToken(
      token({
        aud: [CLIENT, "api"],
        azp: CLIENT,
        exp: NOW - 30,
        nbf: NOW + 30,
      }),
      options(),
    );
    expect(claims.sub).toBe("u1");
  });

  it("refuses malformed tokens and critical header extensions", async () => {
    for (const bad of [
      "",
      "a.b",
      "a.b.c.d",
      `${"x".repeat(70_000)}.a.b`,
      "!!!.e30.AA",
      42,
      token({}, { alg: "RS256", kid: "rsa", crit: ["exp"] }),
      token({}, { alg: "RS256", kid: 7 }),
    ]) {
      expect(await reason(verifyIdToken(bad, options()))).toMatch(
        /^id_token_(malformed|alg)$/,
      );
    }
  });
});

describe("parseJwks", () => {
  it("skips private keys, encryption keys, symmetric keys and RSA keys under 2048 bits", () => {
    const small = rsaKey(1024);
    const parsed = parseJwks({
      keys: [
        jwk(rsa.pub, { kid: "ok" }),
        { ...rsa.priv.export({ format: "jwk" }), kid: "private" },
        jwk(rsa.pub, { kid: "enc", use: "enc" }),
        { kty: "oct", k: "c2VjcmV0", kid: "hmac" },
        jwk(small.pub, { kid: "small" }),
        { kty: "RSA", n: "!!", e: "AQAB", kid: "broken" },
        "not a key",
      ],
    });
    expect(parsed.map((k) => k.kid)).toEqual(["ok"]);
    expect(() => parseJwks({})).toThrow(OidcError);
  });
});

describe("parseMetadata", () => {
  const doc = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
  };

  it("checks the issuer exactly, the endpoints' schemes, PKCE and the client auth method", () => {
    expect(parseMetadata({ issuer: ISSUER }, doc).tokenAuth).toBe(
      "client_secret_basic",
    );
    expect(
      parseMetadata(
        { issuer: ISSUER },
        {
          ...doc,
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        },
      ).tokenAuth,
    ).toBe("client_secret_post");
    for (const bad of [
      { ...doc, issuer: `${ISSUER}/` },
      { ...doc, token_endpoint: "http://idp.example/token" },
      { ...doc, jwks_uri: "https://user:pw@idp.example/jwks" },
      { ...doc, code_challenge_methods_supported: ["plain"] },
      { ...doc, token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      { ...doc, authorization_endpoint: undefined },
      [],
      null,
    ]) {
      expect(() => parseMetadata({ issuer: ISSUER }, bad)).toThrow(OidcError);
    }
    // http:// only to a loopback host (a local provider).
    const local = "http://127.0.0.1:9000";
    expect(() =>
      parseMetadata(
        { issuer: local },
        {
          issuer: local,
          authorization_endpoint: `${local}/a`,
          token_endpoint: `${local}/t`,
          jwks_uri: `${local}/j`,
        },
      ),
    ).not.toThrow();
  });
});

describe("OidcClient network rules", () => {
  const config: OidcConfig = {
    issuer: ISSUER,
    clientId: CLIENT,
    clientSecret: "s".repeat(32),
    redirectUrl: "https://nestrix.example/login/oidc/callback",
    scopes: ["openid", "email"],
    roleClaim: "groups",
    adminGroups: ["admins"],
    allowedGroups: [],
    sessionSeconds: 3600,
  };
  const metadata = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
  };

  it("never follows redirects, caps the body at 1 MiB and retries discovery at most every 10 s", async () => {
    let now = 0;
    const seen: RequestInit[] = [];
    const doFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      // Valid metadata padded with whitespace past the cap, without a Content-Length: only the
      // reader's cap refuses it.
      const text = JSON.stringify(metadata).padEnd(1024 * 1024 + 1, " ");
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(text));
            c.close();
          },
        }),
      );
    }) as unknown as typeof fetch;
    const client = new OidcClient(config, doFetch, () => now);
    expect(await reason(client.discover())).toBe("discovery_failed");
    expect(seen[0]?.redirect).toBe("error");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    now = 5_000;
    expect(await reason(client.discover())).toBe("discovery_failed");
    expect(doFetch).toHaveBeenCalledTimes(1);
    now = 11_000;
    await reason(client.discover());
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("builds the authorization URL with S256 PKCE, state, nonce and the configured redirect", async () => {
    const client = new OidcClient(config, (async () =>
      Response.json(metadata)) as unknown as typeof fetch);
    const url = new URL(
      await client.authorizationUrl({
        state: "S",
        nonce: "N",
        verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      }),
    );
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: config.redirectUrl,
      scope: "openid email",
      state: "S",
      nonce: "N",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
  });

  it("refuses a token response without an ID token, or an error status", async () => {
    for (const answer of [
      () => Response.json({ access_token: "x" }),
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    ]) {
      const client = new OidcClient(config, (async (url: string) =>
        String(url).endsWith("/token")
          ? answer()
          : Response.json(metadata)) as unknown as typeof fetch);
      expect(
        await reason(
          client.complete(
            "code",
            { state: "s", nonce: "n", verifier: "v" },
            NOW,
          ),
        ),
      ).toMatch(/^token_(response_invalid|request_failed)$/);
    }
  });
});

describe("PKCE, comparisons and the role mapping", () => {
  it("computes the RFC 7636 appendix B challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("compares strings exactly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("maps groups to admin, viewer or nothing", () => {
    const config = { adminGroups: ["ops"], allowedGroups: ["eng"] };
    expect(roleFor(config, ["eng", "ops"])).toBe("admin");
    expect(roleFor(config, ["eng"])).toBe("viewer");
    expect(roleFor(config, ["sales"])).toBeUndefined();
    expect(roleFor(config, [])).toBeUndefined();
    expect(roleFor({ adminGroups: [], allowedGroups: ["*"] }, [])).toBe(
      "viewer",
    );
    // Matching is exact: no case folding, no prefixes.
    expect(roleFor(config, ["OPS", "op"])).toBeUndefined();
  });

  it("reads the role claim as own strings only", () => {
    expect(claimValues({ groups: ["a", 1, "b"] }, "groups")).toEqual([
      "a",
      "b",
    ]);
    expect(claimValues({ role: "admin" }, "role")).toEqual(["admin"]);
    expect(claimValues({ groups: { a: 1 } }, "groups")).toEqual([]);
    expect(claimValues({}, "toString")).toEqual([]);
    expect(claimValues({}, "__proto__")).toEqual([]);
  });
});

describe("user session and pending sign-in tokens", () => {
  const secret = Buffer.from("s".repeat(40));
  const key = oidcSessionKey(secret, ISSUER, CLIENT);

  it("round-trips a user session and refuses a changed user id, another key or a too-long expiry", () => {
    const value = signUserSession(key, NOW + 600, 7, NOW);
    expect(verifyUserSession(key, value, NOW, 3600)).toMatchObject({
      userId: 7,
      issuedAtSeconds: NOW,
      expiresAtSeconds: NOW + 600,
    });
    expect(verifyUserSession(key, value.replace(".7.", ".8."), NOW, 3600)).toBe(
      undefined,
    );
    expect(
      verifyUserSession(
        oidcSessionKey(secret, ISSUER, "other"),
        value,
        NOW,
        3600,
      ),
    ).toBe(undefined);
    expect(
      verifyUserSession(
        oidcSessionKey(secret, `${ISSUER}/x`, CLIENT),
        value,
        NOW,
        3600,
      ),
    ).toBe(undefined);
    expect(verifyUserSession(key, value, NOW + 600, 3600)).toBe(undefined);
    const far = signUserSession(key, NOW + 7200, 7, NOW);
    expect(verifyUserSession(key, far, NOW, 3600)).toBe(undefined);
    expect(verifyUserSession(key, `${value}x`, NOW, 3600)).toBe(undefined);
  });

  it("round-trips a pending sign-in for 10 minutes only", () => {
    const pk = pendingKey(secret);
    const p = {
      state: "a".repeat(43),
      nonce: "b".repeat(43),
      verifier: "c".repeat(43),
    };
    const value = signPending(pk, NOW + 600, p);
    expect(verifyPending(pk, value, NOW)).toEqual(p);
    expect(verifyPending(pk, value, NOW + 600)).toBe(undefined);
    expect(
      verifyPending(pendingKey(Buffer.from("t".repeat(40))), value, NOW),
    ).toBe(undefined);
    expect(verifyPending(pk, signPending(pk, NOW + 3600, p), NOW)).toBe(
      undefined,
    );
    expect(verifyPending(pk, value.replace("aaaa", "aaab"), NOW)).toBe(
      undefined,
    );
  });
});

describe("configuration", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/nestrix",
    NESTRIX_INGEST_KEYS: "k".repeat(40),
  };
  const oidc = {
    NESTRIX_OIDC_ISSUER: ISSUER,
    NESTRIX_OIDC_CLIENT_ID: CLIENT,
    NESTRIX_OIDC_CLIENT_SECRET: "top-secret-value-1234567890",
    NESTRIX_PUBLIC_URL: "https://nestrix.example",
    NESTRIX_OIDC_ADMIN_GROUPS: "ops, sre",
  };
  const errorsOf = (env: Record<string, string>) => {
    const r = loadConfig({ ...base, ...env });
    return r.ok ? [] : r.errors;
  };

  it("reads a full OIDC configuration with defaults", () => {
    const r = loadConfig({ ...base, ...oidc });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.config.oidc).toEqual({
      issuer: ISSUER,
      clientId: CLIENT,
      clientSecret: "top-secret-value-1234567890",
      redirectUrl: "https://nestrix.example/login/oidc/callback",
      scopes: ["openid", "email", "profile"],
      roleClaim: "groups",
      adminGroups: ["ops", "sre"],
      allowedGroups: [],
      sessionSeconds: 3600,
    });
    expect(r.config.passwordLogin).toBe(true);
  });

  it("reads the client secret from a file", () => {
    const { NESTRIX_OIDC_CLIENT_SECRET: _, ...rest } = oidc;
    const r = loadConfig(
      {
        ...base,
        ...rest,
        NESTRIX_OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc",
      },
      (path) => {
        if (path !== "/run/secrets/oidc") throw new Error("unexpected path");
        return "from-file-secret\n";
      },
    );
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.config.oidc?.clientSecret).toBe("from-file-secret");
  });

  it.each([
    [
      { NESTRIX_OIDC_ISSUER: "http://idp.example" },
      /NESTRIX_OIDC_ISSUER must be/,
    ],
    [{ NESTRIX_OIDC_ISSUER: `${ISSUER}?x=1` }, /NESTRIX_OIDC_ISSUER must be/],
    [{ NESTRIX_OIDC_CLIENT_ID: "" }, /NESTRIX_OIDC_CLIENT_ID is required/],
    [
      { NESTRIX_OIDC_CLIENT_SECRET: "" },
      /NESTRIX_OIDC_CLIENT_SECRET .*required/,
    ],
    [
      { NESTRIX_PUBLIC_URL: "" },
      /NESTRIX_OIDC_REDIRECT_URL or NESTRIX_PUBLIC_URL/,
    ],
    [
      { NESTRIX_OIDC_REDIRECT_URL: "http://nestrix.example/cb" },
      /REDIRECT_URL must be/,
    ],
    [{ NESTRIX_OIDC_SCOPES: "email profile" }, /must include openid/],
    [{ NESTRIX_OIDC_ADMIN_GROUPS: "*" }, /cannot be "\*"/],
    [
      { NESTRIX_OIDC_ADMIN_GROUPS: "" },
      /ALLOWED_GROUPS or NESTRIX_OIDC_ADMIN_GROUPS is required/,
    ],
    [{ NESTRIX_OIDC_SESSION_SECONDS: "60" }, /NESTRIX_OIDC_SESSION_SECONDS/],
    [{ NESTRIX_ADMIN_PASSWORD_LOGIN: "maybe" }, /accepts "true" or "false"/],
  ])("refuses %j", (over, message) => {
    const env = { ...oidc, ...over } as Record<string, string>;
    for (const [k, v] of Object.entries(env)) if (v === "") delete env[k];
    const errors = errorsOf(env);
    expect(errors.join("\n")).toMatch(message);
    // Secrets are never echoed.
    expect(errors.join("\n")).not.toContain("top-secret-value");
  });

  it("refuses OIDC settings without an issuer, and password login off without OIDC", () => {
    expect(errorsOf({ NESTRIX_OIDC_CLIENT_ID: "x" }).join()).toMatch(
      /set without NESTRIX_OIDC_ISSUER/,
    );
    expect(
      errorsOf({
        NESTRIX_ADMIN_PASSWORD: "p".repeat(16),
        NESTRIX_ADMIN_PASSWORD_LOGIN: "false",
      }).join(),
    ).toMatch(/needs OIDC sign-in/);
    expect(
      errorsOf({ ...oidc, NESTRIX_ADMIN_PASSWORD_LOGIN: "false" }),
    ).toEqual([]);
  });

  it("logs that OIDC is on without the client secret", () => {
    const r = loadConfig({
      ...base,
      ...oidc,
      NESTRIX_SESSION_SECRET: "x".repeat(40),
    });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const { warn, log } = startupMessages(r.config);
    const text = [...warn, ...log].join("\n");
    expect(text).toContain(`OIDC sign-in is on (issuer ${ISSUER})`);
    expect(text).not.toContain("top-secret-value");
  });
});
