import {
  defaultResource,
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { TelemetryConfig } from "./types.js";

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

/**
 * The provider's resource. Precedence, lowest first: the SDK's `defaultResource()`
 * (`service.name` `unknown_service:<argv0>` and `telemetry.sdk.*`), then
 * `OTEL_RESOURCE_ATTRIBUTES`, then `resourceAttributes`, then `serviceName`.
 * `Resource.merge(other)` lets `other` win (resources 3.1.1 `ResourceImpl.merge`).
 */
export function buildResource(
  config: Pick<
    TelemetryConfig,
    "serviceName" | "resourceAttributes" | "otelResourceAttributes"
  >,
  onInvalidEnv?: () => void,
): Resource {
  const fromEnv = parseResourceAttributesEnv(config.otelResourceAttributes);
  if (fromEnv === undefined) onInvalidEnv?.();
  const own: Record<string, string | number | boolean> = {
    ...config.resourceAttributes,
  };
  if (config.serviceName) own[ATTR_SERVICE_NAME] = config.serviceName;
  return defaultResource()
    .merge(resourceFromAttributes(fromEnv ?? {}))
    .merge(resourceFromAttributes(own));
}
