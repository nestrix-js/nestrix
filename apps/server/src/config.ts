/**
 * Server configuration, read once from the environment at start (docs/backlog/phase-5.md,
 * "Settled design"). `loadConfig` never throws: it returns every problem at once so the
 * process can exit with one clear message. Secret values are never echoed in messages.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LogLevel } from "@nestjs/common";
import {
  parseTrustedProxies,
  type TrustedProxies,
} from "./auth/client-address.js";

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
  /**
   * Issue #28, D-101: the environment each key of `keys` (same index) is bound to, or `null` for an
   * unbound key. Records sent with a bound key are stored under its environment, whatever their
   * resource claims (`<environment>:<key>` entries of `NESTRIX_INGEST_KEYS`, `parseIngestKeys`).
   */
  readonly keyEnvironments: readonly (string | null)[];
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

export interface LogConfig {
  /** `NESTRIX_LOG_FORMAT`: one JSON object per line (`json`) or Nest's text lines. */
  readonly json: boolean;
  /** `NESTRIX_LOG_LEVEL` (`info` is Nest's `log`). */
  readonly level: LogLevelName;
  /** Nest log levels enabled at `level`: it and everything more severe. */
  readonly levels: readonly LogLevel[];
  /** True at `info` and above: the route-mapping lines (RouterExplorer, RoutesResolver) are dropped. */
  readonly hideRouteMapping: boolean;
}

/** Native log storage (issue #17, D-106). */
export interface LogStoreConfig {
  /**
   * `NESTRIX_LOGS`: `trace` (default, D-75) keeps only records that carry a trace id, 200 per
   * trace; `all` also keeps records without one and lifts the per-trace cap to `maxPerTrace`.
   */
  readonly mode: "trace" | "all";
  /** `NESTRIX_LOG_RETENTION_DAYS`: days of log lines kept; at most `retentionDays`. */
  readonly retentionDays: number;
  /** `NESTRIX_LOGS_MAX_PER_TRACE` (`all` mode): lines kept per trace. */
  readonly maxPerTrace: number;
  /** `NESTRIX_LOGS_MAX_PER_MINUTE` (`all` mode): lines stored per minute by this process. */
  readonly maxPerMinute: number;
  /** `NESTRIX_LOG_SEARCH_CONCURRENCY`: log searches this process runs at once; more answer 503. */
  readonly searchConcurrency: number;
}

/**
 * Issue #18 (D-105): the optional OTLP metrics receiver. Off by default: `/v1/metrics` then answers
 * `404` with `google.rpc.Status` as before (D-82 (7)).
 */
export interface MetricsConfig {
  /** `NESTRIX_METRICS=on`. */
  readonly enabled: boolean;
  /**
   * `NESTRIX_METRICS_MAX_SERIES_PER_SERVICE`: series (instance x metric x attribute set) a service
   * may have active at once in this server process; points of further series are dropped and counted.
   */
  readonly maxSeriesPerService: number;
  /** `NESTRIX_METRICS_MAX_SERIES`: the same, over every service together. */
  readonly maxSeries: number;
}

/**
 * OpenID Connect sign-in for the dashboard (issue #34, D-104). Present only when
 * `NESTRIX_OIDC_ISSUER` is set; then every field below has been checked.
 */
export interface OidcConfig {
  /** `NESTRIX_OIDC_ISSUER`, exactly as given (compared byte for byte with `iss`). */
  readonly issuer: string;
  readonly clientId: string;
  /** `NESTRIX_OIDC_CLIENT_SECRET` or `NESTRIX_OIDC_CLIENT_SECRET_FILE`. */
  readonly clientSecret: string;
  /** `NESTRIX_OIDC_REDIRECT_URL`, or `NESTRIX_PUBLIC_URL` + `/login/oidc/callback`. Never from `Host`. */
  readonly redirectUrl: string;
  /** `NESTRIX_OIDC_SCOPES` (space or comma separated), always with `openid`. */
  readonly scopes: readonly string[];
  /** `NESTRIX_OIDC_ROLE_CLAIM`, default `groups`: a top-level claim of the ID token, read exactly. */
  readonly roleClaim: string;
  /** `NESTRIX_OIDC_ADMIN_GROUPS`: values of the role claim that make a user admin. */
  readonly adminGroups: readonly string[];
  /**
   * `NESTRIX_OIDC_ALLOWED_GROUPS`: values that let a user sign in as viewer; `*` lets in every user
   * the identity provider signs in for this client. Admin groups are always allowed.
   */
  readonly allowedGroups: readonly string[];
  /** `NESTRIX_OIDC_SESSION_SECONDS` (default 3600): absolute lifetime of an OIDC session. */
  readonly sessionSeconds: number;
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
  /** `NESTRIX_MAX_SPANS_PER_TRACE` (D-78): spans stored per trace; later ones are counted, not stored. */
  readonly maxSpansPerTrace: number;
  readonly alerts: AlertsConfig;
  readonly log: LogConfig;
  /** Native log storage and search (issue #17, D-106). */
  readonly logStore: LogStoreConfig;
  /**
   * `NESTRIX_TRUSTED_PROXIES` (issue #31, D-96): reverse proxies whose `X-Forwarded-For` names the
   * client the login limiter keys on. `undefined`: none, the socket peer is the client.
   */
  readonly trustedProxies: TrustedProxies | undefined;
  /** Issue #18 (D-105): the optional metrics receiver and its limits. */
  readonly metrics: MetricsConfig;
  /** `undefined` unless `NESTRIX_OIDC_ISSUER` is set (issue #34, D-104). */
  readonly oidc?: OidcConfig | undefined;
  /**
   * `NESTRIX_ADMIN_PASSWORD_LOGIN` (default true): whether `NESTRIX_ADMIN_PASSWORD` signs in (the
   * break-glass admin). `false` is accepted only with OIDC configured.
   */
  readonly passwordLogin?: boolean;
  /**
   * `NESTRIX_INDEXED_ATTRIBUTES` (issue #27, D-102): span attribute keys stored per trace in an
   * indexed column at ingest and offered as `attr.<key>=` filters. Empty by default: nothing is
   * indexed. Keys arriving before a key was listed are not backfilled.
   */
  readonly indexedAttributes: readonly string[];
}

export const LOG_LEVEL_NAMES = [
  "verbose",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];
const NEST_LEVEL: Readonly<Record<LogLevelName, LogLevel>> = {
  verbose: "verbose",
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
  fatal: "fatal",
};

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
export const DEFAULT_LOGS_MAX_PER_TRACE = 1_000;
export const DEFAULT_LOGS_MAX_PER_MINUTE = 30_000;
export const DEFAULT_LOG_SEARCH_CONCURRENCY = 2;
export const DEFAULT_MAX_SPANS_PER_TRACE = 50_000;
export const MIN_MAX_SPANS_PER_TRACE = 1_000;
export const MAX_MAX_SPANS_PER_TRACE = 10_000_000;
/** `NESTRIX_INDEXED_ATTRIBUTES` (D-102): at most this many keys, each matching the protocol's pattern. */
export const MAX_INDEXED_ATTRIBUTES = 16;
const INDEXED_ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/**
 * The keys of `NESTRIX_INDEXED_ATTRIBUTES` (comma-separated, spaces ignored, duplicates dropped),
 * with a message per problem in `errors`.
 */
export function parseIndexedAttributes(
  raw: string | undefined,
  errors: string[],
): string[] {
  const keys: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const key = entry.trim();
    if (key === "") continue;
    if (!INDEXED_ATTRIBUTE_KEY.test(key)) {
      errors.push(
        `NESTRIX_INDEXED_ATTRIBUTES: "${key.slice(0, 64)}" is not an attribute name (a letter, then at most 127 letters, digits, '_', '.' or '-').`,
      );
      continue;
    }
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length > MAX_INDEXED_ATTRIBUTES) {
    errors.push(
      `NESTRIX_INDEXED_ATTRIBUTES lists ${keys.length} keys; at most ${MAX_INDEXED_ATTRIBUTES} can be indexed.`,
    );
  }
  return keys;
}

export const DEFAULT_METRICS_MAX_SERIES_PER_SERVICE = 2_000;
export const DEFAULT_METRICS_MAX_SERIES = 20_000;
export const DEFAULT_INGEST: Omit<
  IngestConfig,
  "auth" | "keys" | "keyEnvironments"
> = {
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

/** Removes exactly one trailing line break (`\n` or `\r\n`), as `echo` and most secret stores leave one. */
export function trimOneNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

type ReadFile = (path: string) => string;
const readUtf8: ReadFile = (path) => readFileSync(path, "utf8");

/**
 * The content of the file named by `fileVar` (#33, D-95) with one trailing line break removed, or
 * `undefined` after an error was added: an unreadable file, or an empty one. The content is never
 * put in a message (the path and the system's error code are).
 */
function readSecretFile(
  fileVar: string,
  path: string,
  errors: string[],
  readFile: ReadFile,
): string | undefined {
  let text: string;
  try {
    text = trimOneNewline(readFile(path));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    errors.push(
      `${fileVar}: cannot read "${path}"${typeof code === "string" ? ` (${code})` : ""}.`,
    );
    return undefined;
  }
  if (text.trim() === "") {
    errors.push(`${fileVar}: "${path}" is empty.`);
    return undefined;
  }
  return text;
}

/**
 * The value of secret `name`: the variable itself, or the file named by `<name>_FILE`. Setting
 * both is an error.
 */
function secret(
  env: Env,
  name: string,
  errors: string[],
  readFile: ReadFile,
): string | undefined {
  const direct = present(env, name);
  const fileVar = `${name}_FILE`;
  const path = present(env, fileVar)?.trim();
  if (path === undefined) return direct;
  if (direct !== undefined) {
    errors.push(`${name} and ${fileVar} are both set; set only one of them.`);
    return undefined;
  }
  return readSecretFile(fileVar, path, errors, readFile);
}

export function loadConfig(
  env: Env = process.env,
  readFile: ReadFile = readUtf8,
): ConfigResult {
  const errors: string[] = [];

  const port = integer(env, "PORT", DEFAULT_PORT, 1, 65535, errors);

  let databaseUrl = secret(env, "DATABASE_URL", errors, readFile)?.trim() ?? "";
  const passwordPath = present(env, "DATABASE_PASSWORD_FILE")?.trim();
  const databasePassword =
    passwordPath === undefined
      ? undefined
      : readSecretFile(
          "DATABASE_PASSWORD_FILE",
          passwordPath,
          errors,
          readFile,
        );
  if (databaseUrl === "") {
    // A both-set, unreadable or empty DATABASE_URL_FILE has said why already.
    if (!errors.some((e) => e.startsWith("DATABASE_URL"))) {
      errors.push(
        "DATABASE_URL (or DATABASE_URL_FILE) is required, e.g. postgres://localhost:5432/nestrix.",
      );
    }
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
    } else if (databasePassword !== undefined) {
      // Conservative: a URL that already carries a password is ambiguous, so it is refused.
      const url = new URL(databaseUrl);
      if (url.password !== "" || url.searchParams.has("password")) {
        errors.push(
          "DATABASE_PASSWORD_FILE is set but DATABASE_URL already contains a password; remove one of them.",
        );
      } else if (url.username === "") {
        errors.push(
          "DATABASE_PASSWORD_FILE needs a user name in DATABASE_URL (postgres://user@host/db).",
        );
      } else {
        url.password = databasePassword;
        databaseUrl = url.href;
      }
    }
  }
  if (databaseUrl === "" && databasePassword !== undefined) {
    errors.push("DATABASE_PASSWORD_FILE is set but DATABASE_URL is not.");
  }

  const parsedKeys = parseIngestKeys(
    secret(env, "NESTRIX_INGEST_KEYS", errors, readFile) ?? "",
    errors,
  );
  const keys = parsedKeys.map((k) => k.key);

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

  const adminPassword = secret(env, "NESTRIX_ADMIN_PASSWORD", errors, readFile);
  if (
    adminPassword !== undefined &&
    adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH
  ) {
    errors.push(
      `NESTRIX_ADMIN_PASSWORD needs at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const sessionSecretText = secret(
    env,
    "NESTRIX_SESSION_SECRET",
    errors,
    readFile,
  );
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

  const maxSpansPerTrace = integer(
    env,
    "NESTRIX_MAX_SPANS_PER_TRACE",
    DEFAULT_MAX_SPANS_PER_TRACE,
    MIN_MAX_SPANS_PER_TRACE,
    MAX_MAX_SPANS_PER_TRACE,
    errors,
  );

  const logsRaw = present(env, "NESTRIX_LOGS")?.trim().toLowerCase();
  if (logsRaw !== undefined && logsRaw !== "trace" && logsRaw !== "all") {
    errors.push(`NESTRIX_LOGS accepts "trace" or "all" (got "${logsRaw}").`);
  }
  const logRetentionDays = integer(
    env,
    "NESTRIX_LOG_RETENTION_DAYS",
    retentionDays,
    1,
    MAX_RETENTION_DAYS,
    errors,
  );
  if (logRetentionDays > retentionDays) {
    errors.push(
      `NESTRIX_LOG_RETENTION_DAYS (${logRetentionDays}) cannot exceed NESTRIX_RETENTION_DAYS (${retentionDays}): log partitions are created and dropped with the span partitions.`,
    );
  }
  const logsMaxPerTrace = integer(
    env,
    "NESTRIX_LOGS_MAX_PER_TRACE",
    DEFAULT_LOGS_MAX_PER_TRACE,
    200,
    100_000,
    errors,
  );
  const logsMaxPerMinute = integer(
    env,
    "NESTRIX_LOGS_MAX_PER_MINUTE",
    DEFAULT_LOGS_MAX_PER_MINUTE,
    1,
    100_000_000,
    errors,
  );

  const logSearchConcurrency = integer(
    env,
    "NESTRIX_LOG_SEARCH_CONCURRENCY",
    DEFAULT_LOG_SEARCH_CONCURRENCY,
    1,
    16,
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

  const formatRaw = present(env, "NESTRIX_LOG_FORMAT")?.trim().toLowerCase();
  if (formatRaw !== undefined && formatRaw !== "json" && formatRaw !== "text") {
    errors.push(
      `NESTRIX_LOG_FORMAT accepts "json" or "text" (got "${formatRaw}").`,
    );
  }
  const json =
    formatRaw === undefined
      ? present(env, "NODE_ENV")?.trim() === "production"
      : formatRaw === "json";

  let level: LogLevelName = "info";
  const levelRaw = present(env, "NESTRIX_LOG_LEVEL")?.trim().toLowerCase();
  if (levelRaw !== undefined) {
    const known = LOG_LEVEL_NAMES.find((n) => n === levelRaw);
    // `log` is Nest's own name for info.
    if (known !== undefined) level = known;
    else if (levelRaw === "log") level = "info";
    else {
      errors.push(
        `NESTRIX_LOG_LEVEL accepts ${LOG_LEVEL_NAMES.join(", ")} (got "${levelRaw}").`,
      );
    }
  }
  const levelIndex = LOG_LEVEL_NAMES.indexOf(level);
  const log: LogConfig = Object.freeze({
    json,
    level,
    levels: Object.freeze(
      LOG_LEVEL_NAMES.slice(levelIndex).map((n) => NEST_LEVEL[n]),
    ),
    hideRouteMapping: levelIndex >= LOG_LEVEL_NAMES.indexOf("info"),
  });
  // Issue #31, D-96: only these peers may name the client in X-Forwarded-For.
  const trusted = parseTrustedProxies(present(env, "NESTRIX_TRUSTED_PROXIES"));
  if (!trusted.ok) errors.push(...trusted.errors);
  const trustedProxies = trusted.ok ? trusted.value : undefined;
  const indexedAttributes = parseIndexedAttributes(
    present(env, "NESTRIX_INDEXED_ATTRIBUTES"),
    errors,
  );

  // Issue #18 (D-105): `on` or `off` (default), nothing else.
  const metricsRaw = present(env, "NESTRIX_METRICS")?.trim().toLowerCase();
  if (metricsRaw !== undefined && metricsRaw !== "on" && metricsRaw !== "off") {
    errors.push(`NESTRIX_METRICS accepts "on" or "off" (got "${metricsRaw}").`);
  }
  const maxSeriesPerService = integer(
    env,
    "NESTRIX_METRICS_MAX_SERIES_PER_SERVICE",
    DEFAULT_METRICS_MAX_SERIES_PER_SERVICE,
    10,
    1_000_000,
    errors,
  );
  const maxSeries = integer(
    env,
    "NESTRIX_METRICS_MAX_SERIES",
    DEFAULT_METRICS_MAX_SERIES,
    10,
    10_000_000,
    errors,
  );
  const oidc = loadOidc(env, publicUrl, errors, readFile);
  const passwordLoginRaw = present(env, "NESTRIX_ADMIN_PASSWORD_LOGIN")
    ?.trim()
    .toLowerCase();
  let passwordLogin = true;
  if (passwordLoginRaw !== undefined) {
    if (passwordLoginRaw === "false") passwordLogin = false;
    else if (passwordLoginRaw !== "true") {
      errors.push(
        `NESTRIX_ADMIN_PASSWORD_LOGIN accepts "true" or "false" (got "${passwordLoginRaw.slice(0, 32)}").`,
      );
    }
  }
  if (!passwordLogin && present(env, "NESTRIX_OIDC_ISSUER") === undefined) {
    errors.push(
      "NESTRIX_ADMIN_PASSWORD_LOGIN=false needs OIDC sign-in (NESTRIX_OIDC_ISSUER); otherwise nobody could sign in.",
    );
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
        keyEnvironments: Object.freeze(
          auth === "keys" ? parsedKeys.map((k) => k.environment) : [],
        ),
      }),
      http: Object.freeze({ ...DEFAULT_HTTP, maxConnections }),
      adminPassword,
      sessionSecret:
        sessionSecretText === undefined
          ? randomBytes(32)
          : Buffer.from(sessionSecretText, "utf8"),
      sessionSecretGenerated: sessionSecretText === undefined,
      retentionDays,
      maxSpansPerTrace,
      alerts: Object.freeze({
        allowedHosts: Object.freeze(allowedHosts),
        publicUrl,
      }),
      log,
      logStore: Object.freeze({
        mode: logsRaw === "all" ? "all" : "trace",
        retentionDays: Math.min(logRetentionDays, retentionDays),
        maxPerTrace: logsMaxPerTrace,
        maxPerMinute: logsMaxPerMinute,
        searchConcurrency: logSearchConcurrency,
      }),
      trustedProxies,
      metrics: Object.freeze({
        enabled: metricsRaw === "on",
        maxSeriesPerService,
        maxSeries,
      }),
      oidc,
      passwordLogin,
      indexedAttributes: Object.freeze(indexedAttributes),
    }),
  };
}

/** An environment an ingest key can be bound to: 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
export const INGEST_KEY_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface IngestKeyEntry {
  readonly key: string;
  /** `null`: unbound (records keep the environment their resource claims). */
  readonly environment: string | null;
}

/**
 * `NESTRIX_INGEST_KEYS` (issue #28, D-101): comma-separated entries, each a plain key or
 * `<environment>:<key>`. Entries are trimmed and empty ones skipped. An entry with a `:` is always
 * read as bound: the text before its first `:` is the environment (`INGEST_KEY_ENVIRONMENT`, not
 * `unset`), the rest is the key, which may itself contain `:`. Every key needs 32 characters. The
 * same key listed twice with different bindings is an error (which one applies would be a guess).
 * Messages name the entry by its position, never its text, which may be (part of) a key.
 */
export function parseIngestKeys(
  text: string,
  errors: string[],
): IngestKeyEntry[] {
  const entries: IngestKeyEntry[] = [];
  const bindingOf = new Map<
    string,
    { environment: string | null; n: number }
  >();
  const parts = text
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  parts.forEach((entry, index) => {
    const n = index + 1;
    const colon = entry.indexOf(":");
    let environment: string | null = null;
    let key = entry;
    if (colon >= 0) {
      const name = entry.slice(0, colon);
      key = entry.slice(colon + 1);
      if (!INGEST_KEY_ENVIRONMENT.test(name) || name === "unset") {
        errors.push(
          `NESTRIX_INGEST_KEYS: entry ${n} contains ":", so it is read as <environment>:<key>, but its environment is not 1 to 64 letters, digits, ".", "_" or "-" starting with a letter or digit (and not "unset").`,
        );
        return;
      }
      environment = name;
    }
    if (key.length < MIN_INGEST_KEY_LENGTH) {
      errors.push(
        `NESTRIX_INGEST_KEYS: key ${n} has ${key.length} characters; each key needs at least ${MIN_INGEST_KEY_LENGTH}.`,
      );
      return;
    }
    const earlier = bindingOf.get(key);
    if (earlier !== undefined) {
      if (earlier.environment !== environment) {
        errors.push(
          `NESTRIX_INGEST_KEYS: entries ${earlier.n} and ${n} have the same key with different environments; list each key once.`,
        );
      }
      return;
    }
    bindingOf.set(key, { environment, n });
    entries.push({ key, environment });
  });
  return entries;
}

export const DEFAULT_OIDC_SESSION_SECONDS = 3600;
export const MIN_OIDC_SESSION_SECONDS = 300;
export const MAX_OIDC_SESSION_SECONDS = 8 * 3600;
export const OIDC_CALLBACK_PATH = "/login/oidc/callback";
const LOOPBACK_URL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * An `https://` URL, or `http://` to a loopback host (a local identity provider in development),
 * without credentials or fragment. `allowQuery` for the redirect URL only (never for the issuer).
 */
export function isAcceptableOidcUrl(text: string, allowQuery = false): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "")
    return false;
  if (!allowQuery && url.search !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_URL_HOST.test(url.hostname);
}

function list(raw: string | undefined, separators: RegExp): string[] {
  return (raw ?? "")
    .split(separators)
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** The OIDC settings (D-104), or `undefined` when `NESTRIX_OIDC_ISSUER` is unset. */
function loadOidc(
  env: Env,
  publicUrl: string | undefined,
  errors: string[],
  readFile: ReadFile,
): OidcConfig | undefined {
  const issuer = present(env, "NESTRIX_OIDC_ISSUER")?.trim();
  const clientSecret = secret(
    env,
    "NESTRIX_OIDC_CLIENT_SECRET",
    errors,
    readFile,
  );
  const others = [
    "NESTRIX_OIDC_CLIENT_ID",
    "NESTRIX_OIDC_REDIRECT_URL",
    "NESTRIX_OIDC_SCOPES",
    "NESTRIX_OIDC_ROLE_CLAIM",
    "NESTRIX_OIDC_ADMIN_GROUPS",
    "NESTRIX_OIDC_ALLOWED_GROUPS",
    "NESTRIX_OIDC_SESSION_SECONDS",
  ].filter((name) => present(env, name) !== undefined);
  if (issuer === undefined) {
    if (others.length > 0 || clientSecret !== undefined) {
      errors.push(
        `${[...others, ...(clientSecret === undefined ? [] : ["NESTRIX_OIDC_CLIENT_SECRET"])].join(", ")} set without NESTRIX_OIDC_ISSUER.`,
      );
    }
    return undefined;
  }
  const before = errors.length;
  if (!isAcceptableOidcUrl(issuer)) {
    errors.push(
      "NESTRIX_OIDC_ISSUER must be an https:// URL (http:// only to localhost) without credentials, query or fragment.",
    );
  }
  const clientId = present(env, "NESTRIX_OIDC_CLIENT_ID")?.trim();
  if (clientId === undefined) {
    errors.push("NESTRIX_OIDC_CLIENT_ID is required with NESTRIX_OIDC_ISSUER.");
  } else if (clientId.length > 512) {
    errors.push("NESTRIX_OIDC_CLIENT_ID is longer than 512 characters.");
  }
  if (clientSecret === undefined) {
    if (!errors.some((e) => e.startsWith("NESTRIX_OIDC_CLIENT_SECRET"))) {
      errors.push(
        "NESTRIX_OIDC_CLIENT_SECRET (or NESTRIX_OIDC_CLIENT_SECRET_FILE) is required with NESTRIX_OIDC_ISSUER.",
      );
    }
  }
  let redirectUrl = present(env, "NESTRIX_OIDC_REDIRECT_URL")?.trim();
  if (redirectUrl === undefined) {
    if (publicUrl === undefined) {
      errors.push(
        `NESTRIX_OIDC_REDIRECT_URL or NESTRIX_PUBLIC_URL is required with NESTRIX_OIDC_ISSUER (the callback is <public URL>${OIDC_CALLBACK_PATH}).`,
      );
    } else {
      redirectUrl = `${publicUrl}${OIDC_CALLBACK_PATH}`;
    }
  } else if (!isAcceptableOidcUrl(redirectUrl, true)) {
    errors.push(
      "NESTRIX_OIDC_REDIRECT_URL must be an https:// URL (http:// only to localhost) without credentials or fragment.",
    );
  }
  const scopes = list(present(env, "NESTRIX_OIDC_SCOPES"), /[\s,]+/);
  if (scopes.length === 0) scopes.push("openid", "email", "profile");
  if (!scopes.includes("openid")) {
    errors.push("NESTRIX_OIDC_SCOPES must include openid.");
  }
  if (scopes.some((s) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(s))) {
    errors.push("NESTRIX_OIDC_SCOPES holds a character a scope cannot have.");
  }
  const roleClaim = present(env, "NESTRIX_OIDC_ROLE_CLAIM")?.trim() ?? "groups";
  if (roleClaim.length > 256) {
    errors.push("NESTRIX_OIDC_ROLE_CLAIM is longer than 256 characters.");
  }
  const adminGroups = list(present(env, "NESTRIX_OIDC_ADMIN_GROUPS"), /,/);
  const allowedGroups = list(present(env, "NESTRIX_OIDC_ALLOWED_GROUPS"), /,/);
  if (adminGroups.includes("*")) {
    errors.push(
      'NESTRIX_OIDC_ADMIN_GROUPS cannot be "*": name the groups whose members are admins.',
    );
  }
  if (adminGroups.length === 0 && allowedGroups.length === 0) {
    errors.push(
      'NESTRIX_OIDC_ALLOWED_GROUPS or NESTRIX_OIDC_ADMIN_GROUPS is required with NESTRIX_OIDC_ISSUER: name who may sign in (NESTRIX_OIDC_ALLOWED_GROUPS="*" lets in every user the identity provider signs in).',
    );
  }
  const sessionSeconds = integer(
    env,
    "NESTRIX_OIDC_SESSION_SECONDS",
    DEFAULT_OIDC_SESSION_SECONDS,
    MIN_OIDC_SESSION_SECONDS,
    MAX_OIDC_SESSION_SECONDS,
    errors,
  );
  if (errors.length > before) return undefined;
  return Object.freeze({
    issuer,
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    redirectUrl: redirectUrl as string,
    scopes: Object.freeze(scopes),
    roleClaim,
    adminGroups: Object.freeze(adminGroups),
    allowedGroups: Object.freeze(allowedGroups),
    sessionSeconds,
  });
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
