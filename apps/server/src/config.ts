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
  /**
   * `NESTRIX_TRUSTED_PROXIES` (issue #31, D-96): reverse proxies whose `X-Forwarded-For` names the
   * client the login limiter keys on. `undefined`: none, the socket peer is the client.
   */
  readonly trustedProxies: TrustedProxies | undefined;
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
export const DEFAULT_MAX_SPANS_PER_TRACE = 50_000;
export const MIN_MAX_SPANS_PER_TRACE = 1_000;
export const MAX_MAX_SPANS_PER_TRACE = 10_000_000;
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

  const keys = (secret(env, "NESTRIX_INGEST_KEYS", errors, readFile) ?? "")
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
      maxSpansPerTrace,
      alerts: Object.freeze({
        allowedHosts: Object.freeze(allowedHosts),
        publicUrl,
      }),
      log,
      trustedProxies,
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
