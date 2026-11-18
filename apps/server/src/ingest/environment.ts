/**
 * Ingest keys bound to an environment (issue #28, D-101): a record sent with such a key is stored
 * under the key's environment, whatever its resource claims, so a staging key cannot write
 * production data. The receiver applies it to every resource of a decoded batch before the sink
 * sees it, so the stored resource, its hash and every derived row agree.
 */
import { ENVIRONMENT_KEY, LEGACY_ENVIRONMENT_KEY } from "../storage/derive.js";
import type { IngestAttributes, IngestBatch, IngestLogBatch } from "./model.js";

/** `resource` with `deployment.environment.name` set to `environment` and the deprecated key removed. */
export function withEnvironment(
  resource: IngestAttributes,
  environment: string,
): IngestAttributes {
  const out: IngestAttributes = {};
  for (const [key, value] of Object.entries(resource ?? {})) {
    if (key === ENVIRONMENT_KEY || key === LEGACY_ENVIRONMENT_KEY) continue;
    out[key] = value;
  }
  out[ENVIRONMENT_KEY] = environment;
  return out;
}

/** Rewrites every resource of a trace batch to `environment` (in place). */
export function bindTraceBatch(batch: IngestBatch, environment: string): void {
  for (const rs of batch.resourceSpans) {
    rs.resource = withEnvironment(rs.resource, environment);
  }
}

/** Rewrites every resource of a log batch to `environment` (in place). */
export function bindLogBatch(batch: IngestLogBatch, environment: string): void {
  for (const rl of batch.resourceLogs) {
    rl.resource = withEnvironment(rl.resource, environment);
  }
}
