import { randomUUID } from "node:crypto";
import {
  defaultResource,
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { parseResourceAttributesEnv } from "./resource-env.js";
import type { TelemetryConfig } from "./types.js";

export { parseResourceAttributesEnv };

/**
 * The provider's resource. Precedence, lowest first: the SDK's `defaultResource()`
 * (`service.name` `unknown_service:<argv0>` and `telemetry.sdk.*`), then
 * `OTEL_RESOURCE_ATTRIBUTES`, then `resourceAttributes`, then `serviceName` and
 * `serviceVersion`. `service.instance.id` is a random UUID per call, below all of those, so
 * replicas of one service tell themselves apart unless the host sets the attribute itself.
 * `serviceVersion` is already resolved through its whole chain (D-63:
 * option, `resourceAttributes`, `OTEL_RESOURCE_ATTRIBUTES`, `GIT_SHA`, `npm_package_version`),
 * so setting it last only re-applies the winner.
 * `Resource.merge(other)` lets `other` win (resources 3.1.1 `ResourceImpl.merge`).
 */
export function buildResource(
  config: Pick<
    TelemetryConfig,
    | "serviceName"
    | "serviceVersion"
    | "resourceAttributes"
    | "otelResourceAttributes"
  >,
  onInvalidEnv?: () => void,
): Resource {
  const fromEnv = parseResourceAttributesEnv(config.otelResourceAttributes);
  if (fromEnv === undefined) onInvalidEnv?.();
  const own: Record<string, string | number | boolean> = {
    ...config.resourceAttributes,
  };
  if (config.serviceName) own[ATTR_SERVICE_NAME] = config.serviceName;
  if (config.serviceVersion) own[ATTR_SERVICE_VERSION] = config.serviceVersion;
  return defaultResource()
    .merge(resourceFromAttributes({ [ATTR_SERVICE_INSTANCE_ID]: randomUUID() }))
    .merge(resourceFromAttributes(fromEnv ?? {}))
    .merge(resourceFromAttributes(own));
}
