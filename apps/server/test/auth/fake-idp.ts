/**
 * A fake OpenID Connect provider for the sign-in tests (issue #34): discovery, JWKS, an
 * authorization endpoint that answers at once with a code, and a token endpoint that checks the
 * client's credentials, the code (single use), `redirect_uri` and the PKCE verifier the way a real
 * provider does, then returns an RS256 ID token. Every request is recorded. Test-only keys and
 * secrets.
 */
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const CLIENT_ID = "nestrix-test";
export const CLIENT_SECRET = "c".repeat(32);
export const REDIRECT_URL = "http://localhost/login/oidc/callback";
export const ADMIN_GROUP = "nestrix-admins";
export const VIEWER_GROUP = "engineering";

export function rsaKey(bits = 2048): { priv: KeyObject; pub: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: bits,
  });
  return { priv: privateKey, pub: publicKey };
}

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A compact JWS, RS256 (or `ES256` with an EC key), over exactly the header and payload given. */
export function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const alg = String(header.alg);
  const hash = `sha${alg.slice(2)}`;
  const signature = alg.startsWith("ES")
    ? sign(hash, Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
    : alg.startsWith("PS")
      ? sign(hash, Buffer.from(input), {
          key,
          padding: 6,
          saltLength: Number(alg.slice(2)) / 8,
        })
      : sign(hash, Buffer.from(input), key);
  return `${input}.${signature.toString("base64url")}`;
}

export interface Authorization {
  readonly params: URLSearchParams;
  readonly code: string;
}

export interface FakeIdp {
  readonly issuer: string;
  /** Claims of the next ID token, over the defaults (sub, email, name, groups). */
  claims: Record<string, unknown>;
  /** Changes the next ID token's header and payload just before it is signed. */
  tamper:
    | ((token: {
        header: Record<string, unknown>;
        payload: Record<string, unknown>;
      }) => void)
    | undefined;
  /** Signs with this key instead of the published one (a forged token). */
  signingKey: KeyObject | undefined;
  /** Overrides the discovery document's fields. */
  discovery: Record<string, unknown>;
  /** Answer every request with this status (the provider is down). */
  down: number | undefined;
  readonly authorizations: Authorization[];
  readonly tokenRequests: {
    headers: Record<string, unknown>;
    form: URLSearchParams;
  }[];
  readonly paths: string[];
  close(): Promise<void>;
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const key = rsaKey();
  const jwk = {
    ...key.pub.export({ format: "jwk" }),
    kid: "k1",
    use: "sig",
    alg: "RS256",
  };
  const codes = new Map<
    string,
    {
      challenge: string;
      nonce: string;
      redirect: string;
      claims: Record<string, unknown>;
    }
  >();
  let issuer = "";
  const idp: FakeIdp = {
    get issuer() {
      return issuer;
    },
    claims: {},
    tamper: undefined,
    signingKey: undefined,
    discovery: {},
    down: undefined,
    authorizations: [],
    tokenRequests: [],
    paths: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const json = (
    res: import("node:http").ServerResponse,
    status: number,
    body: unknown,
  ) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    idp.paths.push(url.pathname);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (idp.down !== undefined) {
        res.writeHead(idp.down).end();
        return;
      }
      if (url.pathname === "/.well-known/openid-configuration") {
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          id_token_signing_alg_values_supported: ["RS256"],
          ...idp.discovery,
        });
        return;
      }
      if (url.pathname === "/jwks") {
        json(res, 200, { keys: [jwk] });
        return;
      }
      if (url.pathname === "/authorize") {
        const p = url.searchParams;
        const code = randomBytes(16).toString("hex");
        codes.set(code, {
          challenge: p.get("code_challenge") ?? "",
          nonce: p.get("nonce") ?? "",
          redirect: p.get("redirect_uri") ?? "",
          claims: { ...idp.claims },
        });
        idp.authorizations.push({ params: p, code });
        const back = new URL(p.get("redirect_uri") ?? "http://invalid/");
        back.searchParams.set("code", code);
        back.searchParams.set("state", p.get("state") ?? "");
        res.writeHead(302, { location: back.href }).end();
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        idp.tokenRequests.push({ headers: { ...req.headers }, form });
        const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
        if (req.headers.authorization !== basic) {
          json(res, 401, { error: "invalid_client" });
          return;
        }
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        if (
          form.get("grant_type") !== "authorization_code" ||
          entry === undefined ||
          entry.redirect !== form.get("redirect_uri") ||
          entry.challenge !== challenge
        ) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const token = {
          header: { alg: "RS256", kid: "k1", typ: "JWT" } as Record<
            string,
            unknown
          >,
          payload: {
            iss: issuer,
            aud: CLIENT_ID,
            sub: "user-1",
            email: "ada@example.com",
            name: "Ada",
            groups: [VIEWER_GROUP],
            iat: now,
            exp: now + 300,
            nonce: entry.nonce,
            ...entry.claims,
          } as Record<string, unknown>,
        };
        idp.tamper?.(token);
        json(res, 200, {
          access_token: "at",
          token_type: "Bearer",
          id_token: signJwt(
            token.header,
            token.payload,
            idp.signingKey ?? key.priv,
          ),
        });
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return idp;
}

/** The server environment for OIDC against `idp`. */
export function oidcEnv(idp: FakeIdp, extra: Record<string, string> = {}) {
  return {
    NESTRIX_OIDC_ISSUER: idp.issuer,
    NESTRIX_OIDC_CLIENT_ID: CLIENT_ID,
    NESTRIX_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    NESTRIX_OIDC_REDIRECT_URL: REDIRECT_URL,
    NESTRIX_OIDC_ADMIN_GROUPS: ADMIN_GROUP,
    NESTRIX_OIDC_ALLOWED_GROUPS: VIEWER_GROUP,
    ...extra,
  };
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

/** The `name=value` of the cookie called `prefix…` among `res`'s `Set-Cookie` headers. */
export function cookieFrom(res: Response, prefix: string): string | undefined {
  for (const line of setCookies(res)) {
    const pair = line.split(";", 1)[0] ?? "";
    if (pair.startsWith(prefix)) return pair;
  }
  return undefined;
}

export interface SignIn {
  readonly start: Response;
  readonly callback: Response;
  /** The `nestrix_admin_<port>=v2…` pair, when the sign-in set one. */
  readonly session: string | undefined;
  readonly pending: string;
  readonly state: string;
  readonly code: string;
}

/**
 * The browser's part of a sign-in: `/login/oidc`, the provider's authorization endpoint, then
 * the callback with the pending cookie. `callbackQuery` replaces the provider's answer.
 */
export async function signIn(
  baseUrl: string,
  options: {
    callbackQuery?: (q: URLSearchParams) => void;
    pending?: (cookie: string) => string;
  } = {},
): Promise<SignIn> {
  const start = await fetch(`${baseUrl}/login/oidc`, { redirect: "manual" });
  if (start.status !== 303) throw new Error(`start answered ${start.status}`);
  const pending = cookieFrom(start, "nestrix_oidc_");
  if (pending === undefined) throw new Error("no pending cookie");
  const authorize = await fetch(start.headers.get("location") ?? "", {
    redirect: "manual",
  });
  const back = new URL(authorize.headers.get("location") ?? "");
  const query = new URLSearchParams(back.search);
  const state = query.get("state") ?? "";
  const code = query.get("code") ?? "";
  options.callbackQuery?.(query);
  const callback = await fetch(`${baseUrl}/login/oidc/callback?${query}`, {
    redirect: "manual",
    headers: { cookie: options.pending ? options.pending(pending) : pending },
  });
  return {
    start,
    callback,
    session: cookieFrom(callback, "nestrix_admin_"),
    pending,
    state,
    code,
  };
}
