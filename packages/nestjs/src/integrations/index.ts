/**
 * Level 3 database and cache spans (architecture §4.4): `pg` on by default when installed,
 * `mysql2` and `ioredis` opt-in (D-49). `installIntegrations` is called from `NestrixCore`'s
 * constructor and returns an idempotent disposer; `rescanIntegrations` is called from
 * `NestrixCore.onApplicationBootstrap` to wrap `pg` copies loaded since (D-50). Neither throws.
 */
import type { Diagnostics } from "../diagnostics.js";
import type { ResolvedOptions } from "../resolve-options.js";
import { subscribeIoredis, subscribeMysql2 } from "./channels.js";
import { enablePg, type PgInternals, rescanPg } from "./pg.js";

/** Internal options for tests. Not part of the public API. */
export interface InstallIntegrationsInternals {
  readonly pg?: PgInternals;
}

export function installIntegrations(
  options: ResolvedOptions,
  diagnostics: Diagnostics,
  internals: InstallIntegrationsInternals = {},
): () => void {
  const disposers: Array<() => void> = [];
  const { integrations } = options;
  const steps: Array<[string, () => () => void]> = [];
  if (integrations.pg)
    steps.push(["pg", () => enablePg(diagnostics, internals.pg)]);
  if (integrations.mysql2)
    steps.push(["mysql2", () => subscribeMysql2(diagnostics)]);
  if (integrations.ioredis !== false) {
    const { rootSpans } = integrations.ioredis;
    steps.push(["ioredis", () => subscribeIoredis(diagnostics, { rootSpans })]);
  }
  for (const [name, step] of steps) {
    try {
      disposers.push(step());
    } catch (error) {
      diagnostics.countFailure(`integrations.${name}.install`, error);
    }
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        diagnostics.countFailure("integrations.uninstall", error);
      }
    }
  };
}

/** Wraps `pg` copies loaded since the last scan. A no-op while `pg` is off. */
export function rescanIntegrations(): void {
  rescanPg("bootstrap");
}
