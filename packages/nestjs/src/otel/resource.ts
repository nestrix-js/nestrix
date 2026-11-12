import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
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
import type { TelemetryConfig, TelemetryHandle } from "./types.js";

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

/** Who this instance is, for the remote profiler's check-in (P10-01). Plain values only. */
export interface InstanceIdentity {
  readonly service: string;
  readonly instanceId: string;
  readonly version: string | undefined;
  readonly host: string | undefined;
}

const HOST_NAME = "host.name";

function stringAttribute(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * The identity the remote profiler checks in with. With a Nestrix-owned provider, its resource's
 * values, so `service.instance.id` matches the instance's spans. Otherwise (a host-owned SDK, or a
 * failed setup) the values Nestrix's own resource would have had: the host's resource cannot be
 * read through the API, so the instance id is then random and does not match the host's spans.
 * `host.name` comes from the resource when set there, else from `os.hostname()`. Never throws.
 */
export function instanceIdentity(
  config: Pick<
    TelemetryConfig,
    | "serviceName"
    | "serviceVersion"
    | "resourceAttributes"
    | "otelResourceAttributes"
  >,
  telemetry: Pick<TelemetryHandle, "resourceAttributes"> | undefined,
): InstanceIdentity {
  let attributes: Readonly<Record<string, unknown>> | undefined;
  try {
    attributes =
      telemetry?.resourceAttributes ?? buildResource(config).attributes;
  } catch {
    attributes = undefined;
  }
  let host = stringAttribute(attributes?.[HOST_NAME]);
  if (host === undefined) {
    try {
      host = stringAttribute(hostname());
    } catch {
      host = undefined;
    }
  }
  return Object.freeze({
    service:
      stringAttribute(attributes?.[ATTR_SERVICE_NAME]) ??
      config.serviceName ??
      "unknown_service",
    instanceId:
      stringAttribute(attributes?.[ATTR_SERVICE_INSTANCE_ID]) ?? randomUUID(),
    version:
      stringAttribute(attributes?.[ATTR_SERVICE_VERSION]) ??
      config.serviceVersion,
    host,
  });
}
