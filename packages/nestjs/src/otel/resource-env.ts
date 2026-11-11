/**
 * `OTEL_RESOURCE_ATTRIBUTES` parsing, with no imports, so option resolution can read
 * `service.version` from it (D-63) without loading SDK packages.
 */

/**
 * Parses `OTEL_RESOURCE_ATTRIBUTES` as the specification and `@opentelemetry/resources`
 * 3.1.1's `ResourceAttributesEnvDetector` do: `key=value` pairs separated by commas,
 * percent-decoded, keys and values at most 255 characters. Any error discards the whole
 * value. Returns `undefined` in that case so the caller can say so. Never throws.
 */
export function parseResourceAttributesEnv(
  raw: string | undefined,
): Record<string, string> | undefined {
  try {
    const attributes: Record<string, string> = {};
    if (!raw) return attributes;
    for (const pair of raw.split(",")) {
      if (pair.trim() === "") continue;
      const parts = pair.split("=");
      if (parts.length !== 2) return undefined;
      const key = decodeURIComponent((parts[0] as string).trim());
      const value = decodeURIComponent((parts[1] as string).trim());
      if (key.length === 0 || key.length > 255 || value.length > 255) {
        return undefined;
      }
      attributes[key] = value;
    }
    return attributes;
  } catch {
    return undefined;
  }
}
