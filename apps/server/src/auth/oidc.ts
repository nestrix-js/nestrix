/**
 * OpenID Connect relying party for the dashboard sign-in (issue #34, D-104): the authorization
 * code flow with PKCE (S256), `state` and `nonce`. No dependency: `fetch` and `node:crypto` only.
 *
 * - Discovery: `<issuer>/.well-known/openid-configuration`, whose `issuer` must equal the configured
 *   one exactly (OIDC Discovery 1.0 §4.3); every endpoint must be `https://` (or `http://` to a
 *   loopback host, for a local provider). Cached for an hour; a failure is retried at most every
 *   10 s (until then the sign-in fails at once).
 * - JWKS: cached for an hour; an unknown `kid` refetches it at most once a minute.
 * - ID token (`verifyIdToken`): a compact JWS whose `alg` is RS256/384/512, PS256/384/512 or
 *   ES256/384/512 (never `none` or HMAC), the key chosen by `kid` (or the only key that fits),
 *   checked with `createPublicKey({ format: 'jwk' })` and `crypto.verify`. Claims: `iss` equal to
 *   the issuer, `aud` containing the client id, `azp` equal to the client id when present and
 *   required when there are several audiences, `exp` in the future, `iat` not in the future and at
 *   most 10 minutes old, `nbf` (when present) passed, all with 60 s of skew, `nonce` equal to the
 *   one sent (constant time), `sub` a non-empty string.
 *
 * Every function here throws `OidcError` with a fixed reason code on any failure; callers refuse
 * the sign-in (fail closed). Responses are read with a size cap and a timeout, never following
 * redirects. Nothing from the provider is put in a message except the reason code.
 */
import {
  createHash,
  createPublicKey,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import type { OidcConfig } from "../config.js";
import { isAcceptableOidcUrl } from "../config.js";

/** Why a sign-in failed: a closed set, safe to log and to store in the audit log. */
export type OidcFailure =
  | "discovery_failed"
  | "jwks_failed"
  | "token_request_failed"
  | "token_response_invalid"
  | "id_token_malformed"
  | "id_token_alg"
  | "id_token_key"
  | "id_token_signature"
  | "id_token_iss"
  | "id_token_aud"
  | "id_token_azp"
  | "id_token_exp"
  | "id_token_iat"
  | "id_token_nbf"
  | "id_token_nonce"
  | "id_token_sub"
  | "state_missing"
  | "state_mismatch"
  | "idp_error"
  | "code_missing"
  | "not_allowed"
  | "store_unavailable"
  | "internal";

export class OidcError extends Error {
  constructor(readonly reason: OidcFailure) {
    super(`OIDC sign-in failed: ${reason}`);
    this.name = "OidcError";
  }
}

export interface OidcMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** `client_secret_basic` unless the provider lists only `client_secret_post`. */
  readonly tokenAuth: "client_secret_basic" | "client_secret_post";
}

export interface IdTokenClaims {
  readonly sub: string;
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  /** Every claim, for the role claim. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export const SKEW_SECONDS = 60;
/** Longest age of `iat` accepted (the code exchange follows the sign-in within seconds). */
export const MAX_ID_TOKEN_AGE_SECONDS = 600;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const METADATA_TTL_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10_000;
const JWKS_REFETCH_MS = 60_000;

type Fetch = typeof fetch;

/** `base64url` of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE S256 challenge of `verifier` (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Constant-time equality of two strings (hashed first, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/** A JSON body read with a size cap and a timeout; never follows a redirect. */
async function fetchJson(
  doFetch: Fetch,
  url: string,
  init: RequestInit,
  reason: OidcFailure,
): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new OidcError(reason);
  }
  try {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_RESPONSE_BYTES) throw new OidcError(reason);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new OidcError(reason);
        }
        chunks.push(value);
      }
    }
    if (!response.ok) throw new OidcError(reason);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError(reason);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The metadata of `config.issuer`, checked (see the file comment). Throws `discovery_failed`.
 */
export function parseMetadata(
  config: Pick<OidcConfig, "issuer">,
  doc: unknown,
): OidcMetadata {
  if (!isObject(doc)) throw new OidcError("discovery_failed");
  const { issuer } = doc;
  if (issuer !== config.issuer) throw new OidcError("discovery_failed");
  const endpoint = (name: string): string => {
    const value = doc[name];
    if (typeof value !== "string" || !isAcceptableOidcUrl(value, true))
      throw new OidcError("discovery_failed");
    return value;
  };
  const authorizationEndpoint = endpoint("authorization_endpoint");
  const tokenEndpoint = endpoint("token_endpoint");
  const jwksUri = endpoint("jwks_uri");
  const methods = doc.code_challenge_methods_supported;
  // Listed without S256: the provider would ignore PKCE. Absent: most providers support it anyway.
  if (
    methods !== undefined &&
    (!Array.isArray(methods) || !methods.includes("S256"))
  ) {
    throw new OidcError("discovery_failed");
  }
  const auth = doc.token_endpoint_auth_methods_supported;
  let tokenAuth: OidcMetadata["tokenAuth"] = "client_secret_basic";
  if (auth !== undefined) {
    if (!Array.isArray(auth)) throw new OidcError("discovery_failed");
    if (auth.includes("client_secret_basic")) tokenAuth = "client_secret_basic";
    else if (auth.includes("client_secret_post"))
      tokenAuth = "client_secret_post";
    else throw new OidcError("discovery_failed");
  }
  return Object.freeze({
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    tokenAuth,
  });
}

const ALGS: Readonly<
  Record<
    string,
    { kty: "RSA" | "EC"; hash: string; pss?: boolean; crv?: string }
  >
> = {
  RS256: { kty: "RSA", hash: "sha256" },
  RS384: { kty: "RSA", hash: "sha384" },
  RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", pss: true },
  PS384: { kty: "RSA", hash: "sha384", pss: true },
  PS512: { kty: "RSA", hash: "sha512", pss: true },
  ES256: { kty: "EC", hash: "sha256", crv: "P-256" },
  ES384: { kty: "EC", hash: "sha384", crv: "P-384" },
  ES512: { kty: "EC", hash: "sha512", crv: "P-521" },
};

interface Jwk {
  readonly kid?: string;
  readonly kty: string;
  readonly use?: string;
  readonly alg?: string;
  readonly crv?: string;
  readonly key: KeyObject;
}

/**
 * The signing keys of a JWKS document; keys that cannot be imported, private keys, keys not for
 * signing and RSA keys under 2048 bits are skipped.
 */
export function parseJwks(doc: unknown): Jwk[] {
  if (!isObject(doc) || !Array.isArray(doc.keys))
    throw new OidcError("jwks_failed");
  const out: Jwk[] = [];
  for (const entry of doc.keys.slice(0, 100)) {
    if (!isObject(entry)) continue;
    const { kty, use, alg, kid, crv } = entry;
    if (kty !== "RSA" && kty !== "EC") continue;
    if (use !== undefined && use !== "sig") continue;
    // A private JWK is never accepted as a verification key.
    if (entry.d !== undefined) continue;
    try {
      const key = createPublicKey({
        key: entry as Parameters<typeof createPublicKey>[0] & object,
        format: "jwk",
      } as Parameters<typeof createPublicKey>[0]);
      // RSA keys under 2048 bits are not trusted (NIST SP 800-131A).
      if (
        kty === "RSA" &&
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        continue;
      out.push({
        kty,
        key,
        ...(typeof kid === "string" ? { kid } : {}),
        ...(typeof use === "string" ? { use } : {}),
        ...(typeof alg === "string" ? { alg } : {}),
        ...(typeof crv === "string" ? { crv } : {}),
      });
    } catch {
      // Not a usable key: skip it.
    }
  }
  return out;
}

function decodeJson(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new OidcError("id_token_malformed");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new OidcError("id_token_malformed");
  }
}

export interface VerifyOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly nowSeconds: number;
  /** The keys to try; `refresh` is called once when no key matches the token's `kid`. */
  readonly keys: () => Promise<readonly Jwk[]>;
  readonly refreshKeys: () => Promise<readonly Jwk[]>;
}

function pickKey(
  keys: readonly Jwk[],
  kid: string | undefined,
  alg: string,
): Jwk | undefined {
  if (!Object.hasOwn(ALGS, alg)) return undefined;
  const spec = ALGS[alg] as (typeof ALGS)[string];
  const fits = keys.filter(
    (k) =>
      k.kty === spec.kty &&
      (k.alg === undefined || k.alg === alg) &&
      (spec.crv === undefined || k.crv === undefined || k.crv === spec.crv),
  );
  if (kid !== undefined) return fits.find((k) => k.kid === kid);
  return fits.length === 1 ? fits[0] : undefined;
}

/**
 * The claims of a valid ID token (see the file comment for every check). Throws `OidcError`.
 */
export async function verifyIdToken(
  token: unknown,
  options: VerifyOptions,
): Promise<IdTokenClaims> {
  if (typeof token !== "string" || token.length > 64 * 1024)
    throw new OidcError("id_token_malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("id_token_malformed");
  const [headerText, payloadText, signatureText] = parts as [
    string,
    string,
    string,
  ];
  const header = decodeJson(headerText);
  if (!isObject(header)) throw new OidcError("id_token_malformed");
  const { alg, kid, crit } = header;
  if (typeof alg !== "string" || !Object.hasOwn(ALGS, alg))
    throw new OidcError("id_token_alg");
  // No extension this verifier understands may be marked critical (RFC 7515 §4.1.11).
  if (crit !== undefined) throw new OidcError("id_token_malformed");
  if (kid !== undefined && typeof kid !== "string")
    throw new OidcError("id_token_malformed");
  if (!/^[A-Za-z0-9_-]+$/.test(signatureText))
    throw new OidcError("id_token_malformed");

  let key = pickKey(await options.keys(), kid, alg);
  if (key === undefined) key = pickKey(await options.refreshKeys(), kid, alg);
  if (key === undefined) throw new OidcError("id_token_key");

  const spec = ALGS[alg] as (typeof ALGS)[string];
  const signature = Buffer.from(signatureText, "base64url");
  let valid = false;
  try {
    valid = verifySignature(
      spec.hash,
      Buffer.from(`${headerText}.${payloadText}`, "ascii"),
      spec.kty === "EC"
        ? { key: key.key, dsaEncoding: "ieee-p1363" }
        : spec.pss
          ? {
              key: key.key,
              padding: 6, // RSA_PKCS1_PSS_PADDING
              saltLength: -1, // RSA_PSS_SALTLEN_DIGEST
            }
          : key.key,
      signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new OidcError("id_token_signature");

  const claims = decodeJson(payloadText);
  if (!isObject(claims)) throw new OidcError("id_token_malformed");
  const now = options.nowSeconds;
  if (claims.iss !== options.issuer) throw new OidcError("id_token_iss");
  const aud = claims.aud;
  const audiences =
    typeof aud === "string"
      ? [aud]
      : Array.isArray(aud) && aud.every((a) => typeof a === "string")
        ? (aud as string[])
        : [];
  if (!audiences.includes(options.clientId))
    throw new OidcError("id_token_aud");
  const azp = claims.azp;
  if (azp !== undefined && azp !== options.clientId)
    throw new OidcError("id_token_azp");
  if (audiences.length > 1 && azp === undefined)
    throw new OidcError("id_token_azp");
  const exp = claims.exp;
  if (
    typeof exp !== "number" ||
    !Number.isFinite(exp) ||
    exp + SKEW_SECONDS <= now
  )
    throw new OidcError("id_token_exp");
  const iat = claims.iat;
  if (
    typeof iat !== "number" ||
    !Number.isFinite(iat) ||
    iat > now + SKEW_SECONDS ||
    iat < now - MAX_ID_TOKEN_AGE_SECONDS - SKEW_SECONDS
  )
    throw new OidcError("id_token_iat");
  const nbf = claims.nbf;
  if (
    nbf !== undefined &&
    (typeof nbf !== "number" ||
      !Number.isFinite(nbf) ||
      nbf > now + SKEW_SECONDS)
  )
    throw new OidcError("id_token_nbf");
  const nonce = claims.nonce;
  if (typeof nonce !== "string" || !safeEqual(nonce, options.nonce))
    throw new OidcError("id_token_nonce");
  const sub = claims.sub;
  if (typeof sub !== "string" || sub === "" || sub.length > 255)
    throw new OidcError("id_token_sub");
  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    // Control characters are dropped: these strings are shown in the dashboard and in logs.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return clean === "" ? undefined : clean.slice(0, max);
  };
  return Object.freeze({
    sub,
    email: text(claims.email, 320),
    name: text(claims.name, 200) ?? text(claims.preferred_username, 200),
    raw: claims,
  });
}

/** The values of the role claim: an array of strings, or one string. Anything else: none. */
export function claimValues(
  claims: Readonly<Record<string, unknown>>,
  name: string,
): string[] {
  const value = Object.hasOwn(claims, name) ? claims[name] : undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value
      .filter((v): v is string => typeof v === "string")
      .slice(0, 1000);
  return [];
}

export type Role = "admin" | "viewer";

/** The role a user gets from the claim's values, or `undefined` when they may not sign in. */
export function roleFor(
  config: Pick<OidcConfig, "adminGroups" | "allowedGroups">,
  groups: readonly string[],
): Role | undefined {
  if (groups.some((g) => config.adminGroups.includes(g))) return "admin";
  if (config.allowedGroups.includes("*")) return "viewer";
  if (groups.some((g) => config.allowedGroups.includes(g))) return "viewer";
  return undefined;
}

/** What the sign-in start keeps in the browser (signed cookie) until the callback. */
export interface PendingSignIn {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

/**
 * The provider's metadata and keys, cached (see the file comment), and the two network calls of
 * the flow. `fetch` is replaceable in tests.
 */
export class OidcClient {
  private metadata: { value: OidcMetadata; at: number } | undefined;
  /** `-Infinity`: never (a clock that starts at 0, as in tests, must not look like a failure). */
  private metadataFailedAt = Number.NEGATIVE_INFINITY;
  private metadataLoading: Promise<OidcMetadata> | undefined;
  private jwks: { keys: readonly Jwk[]; at: number } | undefined;
  private jwksFetchedAt = Number.NEGATIVE_INFINITY;
  private jwksLoading: Promise<readonly Jwk[]> | undefined;

  constructor(
    readonly config: OidcConfig,
    private readonly doFetch: Fetch = (input, init) => fetch(input, init),
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** The provider metadata (cached for an hour). Throws `discovery_failed`. */
  async discover(): Promise<OidcMetadata> {
    const now = this.nowMs();
    if (this.metadata && now - this.metadata.at < METADATA_TTL_MS)
      return this.metadata.value;
    if (this.metadataLoading) return this.metadataLoading;
    if (now - this.metadataFailedAt < RETRY_AFTER_FAILURE_MS) {
      // Keep using a stale copy rather than fail while the provider is briefly unreachable.
      if (this.metadata) return this.metadata.value;
      throw new OidcError("discovery_failed");
    }
    const url = `${this.config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    this.metadataLoading = (async () => {
      try {
        const doc = await fetchJson(
          this.doFetch,
          url,
          { headers: { accept: "application/json" } },
          "discovery_failed",
        );
        const value = parseMetadata(this.config, doc);
        this.metadata = { value, at: this.nowMs() };
        return value;
      } catch (error) {
        this.metadataFailedAt = this.nowMs();
        if (this.metadata) return this.metadata.value;
        throw error instanceof OidcError
          ? error
          : new OidcError("discovery_failed");
      } finally {
        this.metadataLoading = undefined;
      }
    })();
    return this.metadataLoading;
  }

  private async loadKeys(force: boolean): Promise<readonly Jwk[]> {
    const now = this.nowMs();
    if (
      !force &&
      this.jwks !== undefined &&
      now - this.jwks.at < METADATA_TTL_MS
    )
      return this.jwks.keys;
    if (force && now - this.jwksFetchedAt < JWKS_REFETCH_MS)
      return this.jwks?.keys ?? [];
    if (this.jwksLoading) return this.jwksLoading;
    this.jwksFetchedAt = now;
    this.jwksLoading = (async () => {
      try {
        const { jwksUri } = await this.discover();
        const keys = parseJwks(
          await fetchJson(
            this.doFetch,
            jwksUri,
            { headers: { accept: "application/json" } },
            "jwks_failed",
          ),
        );
        this.jwks = { keys, at: this.nowMs() };
        return keys;
      } catch (error) {
        if (this.jwks && !force) return this.jwks.keys;
        throw error instanceof OidcError ? error : new OidcError("jwks_failed");
      } finally {
        this.jwksLoading = undefined;
      }
    })();
    return this.jwksLoading;
  }

  /** The URL to send the browser to, for a new pending sign-in. */
  async authorizationUrl(pending: PendingSignIn): Promise<string> {
    const metadata = await this.discover();
    const url = new URL(metadata.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUrl);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", pending.state);
    url.searchParams.set("nonce", pending.nonce);
    url.searchParams.set("code_challenge", pkceChallenge(pending.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.href;
  }

  /** Exchanges `code` and returns the verified ID token's claims. Throws `OidcError`. */
  async complete(
    code: string,
    pending: PendingSignIn,
    nowSeconds: number,
  ): Promise<IdTokenClaims> {
    const metadata = await this.discover();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUrl,
      code_verifier: pending.verifier,
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (metadata.tokenAuth === "client_secret_basic") {
      // RFC 6749 §2.3.1: both parts form-urlencoded before base64.
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
      headers.authorization = `Basic ${Buffer.from(`${enc(this.config.clientId)}:${enc(this.config.clientSecret)}`).toString("base64")}`;
    } else {
      form.set("client_id", this.config.clientId);
      form.set("client_secret", this.config.clientSecret);
    }
    const body = await fetchJson(
      this.doFetch,
      metadata.tokenEndpoint,
      { method: "POST", headers, body: form.toString() },
      "token_request_failed",
    );
    if (!isObject(body) || typeof body.id_token !== "string")
      throw new OidcError("token_response_invalid");
    return verifyIdToken(body.id_token, {
      issuer: metadata.issuer,
      clientId: this.config.clientId,
      nonce: pending.nonce,
      nowSeconds,
      keys: () => this.loadKeys(false),
      refreshKeys: () => this.loadKeys(true),
    });
  }
}
