/**
 * Server configuration, read once from the environment at start (docs/backlog/phase-5.md,
 * "Settled design"). `loadConfig` never throws: it returns every problem at once so the
 * process can exit with one clear message. Secret values are never echoed in messages.
 */
import { randomBytes } from "node:crypto";

export const MIB = 1024 * 1024;

export interface IngestRateLimit {
  /** Tokens added per second to each bucket (one token per export request). */
  readonly requestsPerSecond: number;
  /** Bucket capacity: requests allowed in a burst. */
  readonly burst: number;
}

export interface IngestConfig {
  /**
   * `keys`: requests must carry one of `keys`. `none`: no authentication
   * (`NESTRIX_INGEST_AUTH=none`). `unconfigured`: neither was set, so every request gets 401.
   */
  readonly auth: "keys" | "none" | "unconfigured";
  /** API keys, each at least 32 characters. Empty unless `auth` is `keys`. */
  readonly keys: readonly string[];
  /** Limit on the request body, applied to the compressed bytes and, separately, to the decompressed size. */
  readonly maxBodyBytes: number;
  /** Per key (per client address when `auth` is `none`). */
  readonly rateLimit: IngestRateLimit;
  /** Spans per request (413 beyond). */
  readonly maxSpans: number;
  /** Protobuf submessages, or JSON objects, per request (413 beyond). */
  readonly maxMessages: number;
  /** JSON `{`, `[` and `,` per request (413 beyond). */
  readonly maxJsonTokens: number;
  /**
   * Process-wide memory budget for requests in flight: buffered body bytes plus an estimate of
   * the decoded objects. Full: 503 with Retry-After. A single request larger than it: 413.
   */
  readonly inflightBudgetBytes: number;
  /** After an early answer, the unread body is discarded for at most this long, then the connection is destroyed. */
  readonly discardTimeoutMs: number;
}

export interface HttpServerConfig {
  /** `NESTRIX_MAX_CONNECTIONS`; Node's `server.maxConnections`. */
  readonly maxConnections: number;
  /** Node's `server.requestTimeout`: the whole request, headers and body, must arrive within it. */
  readonly requestTimeoutMs: number;
  /** Node's `server.headersTimeout`. */
  readonly headersTimeoutMs: number;
}

export interface AlertsConfig {
  /**
   * `NESTRIX_WEBHOOK_ALLOWED_HOSTS`: webhook hostnames (lower case; IP literals as `new URL`
   * serializes them, IPv6 without brackets) exempt from the private-address check. Empty by default.
   */
  readonly allowedHosts: readonly string[];
  /** `NESTRIX_PUBLIC_URL`: the dashboard's address for links in notifications, without a trailing slash. */
  readonly publicUrl: string | undefined;
}

export interface ServerConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly ingest: IngestConfig;
  readonly http: HttpServerConfig;
  /** `undefined` when `NESTRIX_ADMIN_PASSWORD` is unset: the UI and query API then answer 503 (P5-04). */
  readonly adminPassword: string | undefined;
  /** `NESTRIX_SESSION_SECRET` as UTF-8 bytes, or 32 random bytes per start. */
  readonly sessionSecret: Buffer;
  /** True when `sessionSecret` was generated at start (sessions do not survive a restart). */
  readonly sessionSecretGenerated: boolean;
  readonly retentionDays: number;
  readonly alerts: AlertsConfig;
}

export type ConfigResult =
  | { ok: true; config: ServerConfig }
  | { ok: false; errors: string[] };

export const DEFAULT_PORT = 4318;
export const DEFAULT_RETENTION_DAYS = 7;
export const MIN_INGEST_KEY_LENGTH = 32;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
export const MIN_SESSION_SECRET_LENGTH = 32;
export const MAX_RETENTION_DAYS = 3650;
export const DEFAULT_MAX_CONNECTIONS = 1024;
export const DEFAULT_INGEST: Omit<IngestConfig, "auth" | "keys"> = {
  // As the OpenTelemetry Collector's OTLP receiver. A single request at every cap below is
  // charged about 20 MiB + (400k + 100k) x 512 B = 264 MiB of the budget, so it always fits.
  maxBodyBytes: 20 * MIB,
  rateLimit: { requestsPerSecond: 100, burst: 200 },
  maxSpans: 100_000,
  maxMessages: 400_000,
  maxJsonTokens: 1_200_000,
  inflightBudgetBytes: 320 * MIB,
  discardTimeoutMs: 5_000,
};
export const DEFAULT_HTTP: Omit<HttpServerConfig, "maxConnections"> = {
  requestTimeoutMs: 60_000,
  headersTimeoutMs: 20_000,
};

type Env = Readonly<Record<string, string | undefined>>;

function present(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = present(env, name);
  if (raw === undefined) return fallback;
  const text = raw.trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(
      `${name} must be a whole number from ${min} to ${max} (got "${text}").`,
    );
    return fallback;
  }
  return value;
}

export function loadConfig(env: Env = process.env): ConfigResult {
  const errors: string[] = [];

  const port = integer(env, "PORT", DEFAULT_PORT, 1, 65535, errors);

  const databaseUrl = present(env, "DATABASE_URL")?.trim() ?? "";
  if (databaseUrl === "") {
    errors.push(
      "DATABASE_URL is required, e.g. postgres://localhost:5432/nestrix.",
    );
  } else {
    let protocol: string | undefined;
    try {
      protocol = new URL(databaseUrl).protocol;
    } catch {
      protocol = undefined;
    }
    if (protocol !== "postgres:" && protocol !== "postgresql:") {
      // The value may hold a password: it is not echoed.
      errors.push("DATABASE_URL must be a postgres:// or postgresql:// URL.");
    }
  }

  const keys = (env.NESTRIX_INGEST_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  keys.forEach((key, index) => {
    if (key.length < MIN_INGEST_KEY_LENGTH) {
      errors.push(
        `NESTRIX_INGEST_KEYS: key ${index + 1} has ${key.length} characters; each key needs at least ${MIN_INGEST_KEY_LENGTH}.`,
      );
    }
  });

  const authOptOut = present(env, "NESTRIX_INGEST_AUTH")?.trim();
  if (authOptOut !== undefined && authOptOut !== "none") {
    errors.push(
      `NESTRIX_INGEST_AUTH accepts only "none" (got "${authOptOut}"). Leave it unset to require NESTRIX_INGEST_KEYS.`,
    );
  }
  if (authOptOut === "none" && keys.length > 0) {
    errors.push(
      "NESTRIX_INGEST_AUTH=none and NESTRIX_INGEST_KEYS are both set; set only one of them.",
    );
  }
  const auth: IngestConfig["auth"] =
    keys.length > 0 ? "keys" : authOptOut === "none" ? "none" : "unconfigured";

  const adminPassword = present(env, "NESTRIX_ADMIN_PASSWORD");
  if (
    adminPassword !== undefined &&
    adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH
  ) {
    errors.push(
      `NESTRIX_ADMIN_PASSWORD needs at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const sessionSecretText = present(env, "NESTRIX_SESSION_SECRET");
  if (
    sessionSecretText !== undefined &&
    sessionSecretText.length < MIN_SESSION_SECRET_LENGTH
  ) {
    errors.push(
      `NESTRIX_SESSION_SECRET needs at least ${MIN_SESSION_SECRET_LENGTH} characters (or leave it unset for a random one per start).`,
    );
  }

  const maxConnections = integer(
    env,
    "NESTRIX_MAX_CONNECTIONS",
    DEFAULT_MAX_CONNECTIONS,
    1,
    1_000_000,
    errors,
  );

  const retentionDays = integer(
    env,
    "NESTRIX_RETENTION_DAYS",
    DEFAULT_RETENTION_DAYS,
    1,
    MAX_RETENTION_DAYS,
    errors,
  );

  const allowedHosts: string[] = [];
  const allowedRaw = (env.NESTRIX_WEBHOOK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  for (const entry of allowedRaw) {
    const host = normalizeAllowedHost(entry);
    if (host === undefined) {
      errors.push(
        `NESTRIX_WEBHOOK_ALLOWED_HOSTS: "${entry}" is not a host name or IP address (no scheme, port or path).`,
      );
    } else {
      allowedHosts.push(host);
    }
  }

  let publicUrl: string | undefined;
  const publicRaw = present(env, "NESTRIX_PUBLIC_URL")?.trim();
  if (publicRaw !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(publicRaw);
    } catch {
      url = undefined;
    }
    if (
      url === undefined ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      errors.push(
        "NESTRIX_PUBLIC_URL must be an http:// or https:// URL without credentials, query or fragment.",
      );
    } else {
      publicUrl = url.href.replace(/\/+$/, "");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: Object.freeze({
      port,
      databaseUrl,
      ingest: Object.freeze({
        ...DEFAULT_INGEST,
        auth,
        keys: Object.freeze(auth === "keys" ? keys : []),
      }),
      http: Object.freeze({ ...DEFAULT_HTTP, maxConnections }),
      adminPassword,
      sessionSecret:
        sessionSecretText === undefined
          ? randomBytes(32)
          : Buffer.from(sessionSecretText, "utf8"),
      sessionSecretGenerated: sessionSecretText === undefined,
      retentionDays,
      alerts: Object.freeze({
        allowedHosts: Object.freeze(allowedHosts),
        publicUrl,
      }),
    }),
  };
}

/**
 * An allowlist entry as `new URL(...).hostname` gives it for a webhook URL (lower case, IPv4
 * normalized, IPv6 compressed and without brackets), or `undefined` when the entry holds
 * anything but a host (a scheme, port, path, credentials).
 */
export function normalizeAllowedHost(entry: string): string | undefined {
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(entry)) return undefined;
  const bracketed =
    entry.includes(":") && !entry.startsWith("[") ? `[${entry}]` : entry;
  let url: URL;
  try {
    url = new URL(`http://${bracketed}/`);
  } catch {
    return undefined;
  }
  if (url.port !== "" || url.hostname === "") return undefined;
  const host = url.hostname;
  return host.startsWith("[") ? host.slice(1, -1) : host;
}

export function formatConfigErrors(errors: readonly string[]): string {
  return [
    "nestrix-server: invalid configuration, not starting:",
    ...errors.map((e) => `  - ${e}`),
  ].join("\n");
}
