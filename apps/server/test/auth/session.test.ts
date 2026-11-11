// Session cookies: signature, expiry, tampering, forging, revocation; unit and over HTTP.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminAuth } from "../../src/auth/admin-auth.js";
import {
  RevokedSessions,
  SESSION_TTL_SECONDS,
  sessionKey,
  signSession,
  verifySession,
} from "../../src/auth/session.js";
import { lastServer, type TestServer } from "../ingest/helpers.js";
import {
  ADMIN_PW,
  cookieName,
  SESSION_SECRET,
  signedCookie,
  startAuthServer,
} from "./helpers.js";

const key = sessionKey(Buffer.from(SESSION_SECRET), ADMIN_PW);
const now = 1_800_000_000;

describe("verifySession", () => {
  it("accepts its own token until it expires", () => {
    const token = signSession(key, now + 60);
    expect(verifySession(key, token, now)?.expiresAtSeconds).toBe(now + 60);
    expect(verifySession(key, token, now + 59)).toBeDefined();
    expect(verifySession(key, token, now + 60)).toBeUndefined();
  });

  it("refuses tampered, re-signed, malformed and far-future tokens", () => {
    const token = signSession(key, now + 60);
    const [v, exp, nonce, mac] = token.split(".") as [
      string,
      string,
      string,
      string,
    ];
    const flip = (s: string) =>
      s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.slice(-1);
    const candidates: unknown[] = [
      `${v}.${Number(exp) + 3600}.${nonce}.${mac}`, // later expiry, old MAC
      `${v}.${exp}.${flip(nonce)}.${mac}`,
      `${v}.${exp}.${nonce}.${flip(mac)}`,
      `v2.${exp}.${nonce}.${mac}`,
      `${token}.x`,
      `${v}.${exp}.${nonce}`,
      "",
      "garbage",
      undefined,
      42,
      signSession(sessionKey(randomBytes(32), ADMIN_PW), now + 60), // other secret
      signSession(
        sessionKey(Buffer.from(SESSION_SECRET), `${ADMIN_PW}!`),
        now + 60,
      ), // password changed
      signSession(key, now + SESSION_TTL_SECONDS + 3600), // valid MAC, expiry too far ahead
    ];
    for (const candidate of candidates) {
      expect(
        verifySession(key, candidate, now),
        String(candidate),
      ).toBeUndefined();
    }
  });
});

describe("RevokedSessions", () => {
  it("forgets expired entries and stays bounded", () => {
    const revoked = new RevokedSessions(3);
    revoked.revoke({ nonce: "a", expiresAtSeconds: now + 10 }, now);
    revoked.revoke({ nonce: "b", expiresAtSeconds: now + 100 }, now);
    expect(revoked.has("a")).toBe(true);
    revoked.revoke({ nonce: "c", expiresAtSeconds: now + 100 }, now + 20);
    expect(revoked.has("a")).toBe(false); // expired, pruned
    revoked.revoke({ nonce: "d", expiresAtSeconds: now + 100 }, now + 20);
    revoked.revoke({ nonce: "e", expiresAtSeconds: now + 100 }, now + 20);
    expect(revoked.size).toBe(3);
    expect(revoked.has("b")).toBe(false); // oldest dropped at the bound
    expect(revoked.has("e")).toBe(true);
  });
});

describe("over HTTP", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startAuthServer();
  });
  afterAll(async () => {
    await server?.close();
  });

  async function status(path: string, cookie?: string): Promise<number> {
    const res = await fetch(`${server.baseUrl}${path}`, {
      headers: cookie === undefined ? {} : { cookie },
      redirect: "manual",
    });
    return res.status;
  }

  it("admits a valid signed cookie, also among other cookies", async () => {
    expect(await status("/", signedCookie())).toBe(200);
    expect(
      await status(
        "/",
        `a=1; ${cookieName()}=forged; ${signedCookie()}; b="2"`,
      ),
    ).toBe(200);
  });

  it("refuses forged, tampered, expired and foreign cookies: 303 for the UI, 401 for the API", async () => {
    const valid = signedCookie().split("=")[1] as string;
    const nowS = Math.floor(Date.now() / 1000);
    const bad = [
      undefined,
      `${cookieName()}=`,
      `${cookieName()}=${randomBytes(48).toString("base64url")}`,
      // A changed character in the middle of the MAC (always different bytes).
      `${cookieName()}=${valid.slice(0, -10)}${valid.at(-10) === "A" ? "B" : "A"}${valid.slice(-9)}`,
      // The same MAC bytes spelled with different unused trailing bits: not canonical, refused.
      `${cookieName()}=${valid.slice(0, -1)}${String.fromCharCode(valid.charCodeAt(valid.length - 1) ^ 1)}`,
      `${cookieName()}=${valid.replace(/^v1\.(\d+)/, (_, e) => `v1.${Number(e) + 100}`)}`,
      signedCookie(nowS - 1), // expired, correctly signed
      signedCookie(nowS + 3600, "o".repeat(40)), // another secret
      signedCookie(nowS + 3600, SESSION_SECRET, "b".repeat(24)), // another password
      `nestrix_admin_other=${valid}`, // right value, wrong name
      `nestrix_admin=${valid}`, // the port-less name is not read
    ];
    for (const cookie of bad) {
      expect(await status("/", cookie), String(cookie)).toBe(303);
      expect(await status("/assets/x.js", cookie), String(cookie)).toBe(303);
      const api = await fetch(`${server.baseUrl}/api/v1/meta`, {
        headers: cookie === undefined ? {} : { cookie },
      });
      expect(api.status, String(cookie)).toBe(401);
      expect(api.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(await api.json()).toEqual({
        error: { code: "unauthorized", message: "Sign in at /login." },
      });
    }
  });

  it("refuses a cookie signed by an earlier process with the same secret and password", async () => {
    const earlier = sessionKey(
      Buffer.from(SESSION_SECRET),
      ADMIN_PW,
      randomBytes(32),
    );
    const nowS = Math.floor(Date.now() / 1000);
    const cookie = `${cookieName()}=${signSession(earlier, nowS + 3600)}`;
    expect(await status("/", cookie)).toBe(303);
    expect(await status("/api/v1/meta", cookie)).toBe(401);
    expect(await status("/", signedCookie())).toBe(200); // this process's own key works
  });

  it("refuses a cookie that a restarted AdminAuth would not have signed", async () => {
    const config = {
      adminPassword: ADMIN_PW,
      sessionSecret: Buffer.from(SESSION_SECRET),
    };
    const mine = server.app.get(AdminAuth);
    const token = signedCookie().split("=")[1] as string;
    const req = (t: string) =>
      ({
        headers: { cookie: `${cookieName()}=${t}` },
        socket: { localPort: lastServer.port },
      }) as never;
    expect(mine.sessionOf(req(token))).toBeDefined();
    const other = new AdminAuth(config as never) as unknown as { key: Buffer };
    const foreign = signSession(
      sessionKey(config.sessionSecret, ADMIN_PW, randomBytes(32)),
      Math.floor(Date.now() / 1000) + 3600,
    );
    expect(mine.sessionOf(req(foreign))).toBeUndefined();
    expect(other.key.equals(sessionKey(config.sessionSecret, ADMIN_PW))).toBe(
      true,
    );
  });

  it("fails closed when the session check itself throws", async () => {
    const auth = server.app.get(AdminAuth);
    const original = auth.nowSeconds;
    auth.nowSeconds = () => {
      throw new Error("injected fault");
    };
    try {
      expect(await status("/", signedCookie())).toBe(303);
      expect(await status("/api/v1/meta", signedCookie())).toBe(401);
    } finally {
      auth.nowSeconds = original;
    }
  });

  it("fails closed with 500 when the middleware's decision throws", async () => {
    const auth = server.app.get(AdminAuth) as unknown as {
      decide: (...args: unknown[]) => boolean;
    };
    const original = auth.decide;
    auth.decide = () => {
      throw new Error("injected fault");
    };
    try {
      expect(await status("/", signedCookie())).toBe(500);
      expect(await status("/api/v1/meta", signedCookie())).toBe(500);
    } finally {
      auth.decide = original;
    }
  });
});
