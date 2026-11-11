export interface NestrixConfig {
  service?: string;
  /** Query-API base, relative to `<base href>`. */
  apiBase: string;
  /** Mount path of the dashboard on the host, for display. */
  path?: string;
  protocolVersion?: number;
}

const DEFAULT_API_BASE = "api/v1/";

/** Reads the JSON block the server fills in; never throws. */
export function readConfig(): NestrixConfig {
  let parsed: Record<string, unknown> = {};
  try {
    const text = document.getElementById("nestrix-config")?.textContent ?? "";
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null)
      parsed = value as Record<string, unknown>;
  } catch {
    // An unfilled or malformed block leaves the defaults.
  }
  const apiBase =
    typeof parsed.apiBase === "string" && parsed.apiBase !== ""
      ? parsed.apiBase
      : DEFAULT_API_BASE;
  return {
    service: typeof parsed.service === "string" ? parsed.service : undefined,
    apiBase: apiBase.endsWith("/") ? apiBase : `${apiBase}/`,
    path: typeof parsed.path === "string" ? parsed.path : undefined,
    protocolVersion:
      typeof parsed.protocolVersion === "number"
        ? parsed.protocolVersion
        : undefined,
  };
}
