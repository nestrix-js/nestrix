/** Configuration of the MCP server, read from environment variables. */
export interface McpConfig {
  /** Base URL of the dashboard (`http://localhost:3000/_nestrix`) or the standalone server, without a trailing slash. */
  url: string;
  token: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

/** A configuration problem, with a message meant to be shown to the person who set the variables. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Reads `NESTRIX_URL`, `NESTRIX_TOKEN` and `NESTRIX_TIMEOUT_MS`. Throws `ConfigError`. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): McpConfig {
  const rawUrl = env.NESTRIX_URL?.trim();
  if (!rawUrl) {
    throw new ConfigError(
      "NESTRIX_URL is not set. Set it to the base URL of the Nestrix dashboard (for example http://localhost:3000/_nestrix) or of the Nestrix server (for example http://localhost:4318).",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConfigError(`NESTRIX_URL is not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("NESTRIX_URL must start with http:// or https://.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigError(
      "NESTRIX_URL must not contain a user name or password. Put the token in NESTRIX_TOKEN.",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  const url = parsed.toString().replace(/\/+$/, "");

  const token = env.NESTRIX_TOKEN?.trim();
  if (!token) {
    throw new ConfigError(
      "NESTRIX_TOKEN is not set. For an app's embedded dashboard use the app's `ui.auth.token` (the app must run with `ui: { enabled: true, auth: { token } }`); for the Nestrix server use an API token created in its settings.",
    );
  }

  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new ConfigError(
      "NESTRIX_TOKEN contains whitespace, control or non-ASCII characters, so it cannot be sent as an HTTP header. Check it for a stray newline or a bad copy-paste (the value is not shown).",
    );
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.NESTRIX_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n < 100 || n > 120_000) {
      throw new ConfigError(
        "NESTRIX_TIMEOUT_MS must be a whole number of milliseconds between 100 and 120000.",
      );
    }
    timeoutMs = n;
  }
  return { url, token, timeoutMs };
}

/** True for `localhost`, `127.x.y.z` and `[::1]`. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "[::1]" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  } catch {
    return false;
  }
}
