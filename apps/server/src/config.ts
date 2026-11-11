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
}

export interface ServerConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly ingest: IngestConfig;
  /** `undefined` when `NESTRIX_ADMIN_PASSWORD` is unset: the UI and query API then answer 503 (P5-04). */
  readonly adminPassword: string | undefined;
  /** `NESTRIX_SESSION_SECRET` as UTF-8 bytes, or 32 random bytes per start. */
  readonly sessionSecret: Buffer;
  /** True when `sessionSecret` was generated at start (sessions do not survive a restart). */
  readonly sessionSecretGenerated: boolean;
  readonly retentionDays: number;
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
export const DEFAULT_INGEST: Omit<IngestConfig, "auth" | "keys"> = {
  maxBodyBytes: 64 * MIB,
  rateLimit: { requestsPerSecond: 100, burst: 200 },
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

  const retentionDays = integer(
    env,
    "NESTRIX_RETENTION_DAYS",
    DEFAULT_RETENTION_DAYS,
    1,
    MAX_RETENTION_DAYS,
    errors,
  );

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
      adminPassword,
      sessionSecret:
        sessionSecretText === undefined
          ? randomBytes(32)
          : Buffer.from(sessionSecretText, "utf8"),
      sessionSecretGenerated: sessionSecretText === undefined,
      retentionDays,
    }),
  };
}

export function formatConfigErrors(errors: readonly string[]): string {
  return [
    "nestrix-server: invalid configuration, not starting:",
    ...errors.map((e) => `  - ${e}`),
  ].join("\n");
}
