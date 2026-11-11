/**
 * The admin session: a stateless, HMAC-signed cookie value with an expiry, and a bounded list of
 * sessions ended by `/logout` (backlog P5-04).
 *
 * Token: `v1.<expiresAtSeconds>.<nonce>.<mac>`, where `nonce` is 16 random bytes and `mac` is
 * HMAC-SHA256 over `v1.<expiresAtSeconds>.<nonce>`, both base64url. The key is derived from the
 * session secret, a digest of the admin password and a random value drawn once per process. So
 * changing the password ends every session, and so does restarting the server: logout
 * revocations live in memory, and a fixed `NESTRIX_SESSION_SECRET` must not bring a signed-out
 * cookie back to life.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const SESSION_COOKIE = "nestrix_admin";

/**
 * The cookie name for the port the request arrived on. Cookies are not isolated by port, so a
 * bare name would be sent to every other server on the same host (as the embedded dashboard does,
 * architecture 4.7).
 */
export function sessionCookieName(localPort: unknown): string {
  return typeof localPort === "number" &&
    Number.isInteger(localPort) &&
    localPort > 0 &&
    localPort < 65536
    ? `${SESSION_COOKIE}_${localPort}`
    : SESSION_COOKIE;
}

/** Random per process; part of every session key. */
export const PROCESS_SALT: Buffer = randomBytes(32);
/** Absolute lifetime of a session. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const VERSION = "v1";
const KEY_LABEL = "nestrix.server.session.v1";
const TOKEN = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The HMAC key of sessions for this secret, password and process salt. */
export function sessionKey(
  secret: Buffer,
  password: string,
  salt: Buffer = PROCESS_SALT,
): Buffer {
  return createHmac("sha256", secret)
    .update(`${KEY_LABEL}\0`)
    .update(sha256(password))
    .update(salt)
    .digest();
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** A signed token. `nonce` is 16 bytes (random unless a test passes one). */
export function signSession(
  key: Buffer,
  expiresAtSeconds: number,
  nonce: Buffer = randomBytes(16),
): string {
  const payload = `${VERSION}.${expiresAtSeconds}.${nonce.toString("base64url")}`;
  return `${payload}.${mac(key, payload).toString("base64url")}`;
}

export interface VerifiedSession {
  readonly nonce: string;
  readonly expiresAtSeconds: number;
}

/**
 * The session in `token` when its format and signature are valid and it has not expired, else
 * `undefined`. The MAC is compared with `timingSafeEqual` (both 32 bytes). A token whose expiry
 * lies further ahead than one lifetime is refused too. Never throws.
 */
export function verifySession(
  key: Buffer,
  token: unknown,
  nowSeconds: number,
): VerifiedSession | undefined {
  try {
    if (typeof token !== "string") return undefined;
    const match = TOKEN.exec(token);
    if (!match) return undefined;
    const [, expText, nonce, macText] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    const expected = mac(key, `${VERSION}.${expText}.${nonce}`);
    const given = Buffer.from(macText, "base64url");
    if (given.length !== expected.length) return undefined;
    const valid = timingSafeEqual(given, expected);
    const expiresAtSeconds = Number(expText);
    if (!valid) return undefined;
    if (expiresAtSeconds <= nowSeconds) return undefined;
    if (expiresAtSeconds > nowSeconds + SESSION_TTL_SECONDS + 60)
      return undefined;
    return { nonce, expiresAtSeconds };
  } catch {
    return undefined;
  }
}

/**
 * Sessions ended by `/logout` before their expiry, kept until they expire. Bounded: past
 * `max` entries the oldest is forgotten (it may then be accepted again until it expires).
 */
export class RevokedSessions {
  static readonly MAX = 10_000;
  private readonly revoked = new Map<string, number>();

  constructor(private readonly max = RevokedSessions.MAX) {}

  revoke(session: VerifiedSession, nowSeconds: number): void {
    this.prune(nowSeconds);
    this.revoked.delete(session.nonce);
    this.revoked.set(session.nonce, session.expiresAtSeconds);
    while (this.revoked.size > this.max) {
      const oldest = this.revoked.keys().next().value;
      if (oldest === undefined) break;
      this.revoked.delete(oldest);
    }
  }

  has(nonce: string): boolean {
    return this.revoked.has(nonce);
  }

  get size(): number {
    return this.revoked.size;
  }

  private prune(nowSeconds: number): void {
    for (const [nonce, exp] of this.revoked) {
      if (exp <= nowSeconds) this.revoked.delete(nonce);
    }
  }
}
