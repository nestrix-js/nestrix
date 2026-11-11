import type { Lookup } from "./webhook.js";

export const ALERTS_OPTIONS = Symbol("nestrix-server:alerts-options");

export interface AlertsModuleOptions {
  /** Evaluation interval. Default 60 000 ms. */
  intervalMs?: number;
  /** First evaluation after start. Default 10 000 ms. */
  initialDelayMs?: number;
  /** False: no timer (tests drive `AlertEvaluator.runOnce`). Default true. */
  schedule?: boolean;
  /** Webhook sender overrides, for tests. */
  webhook?: {
    timeoutMs?: number;
    maxAttempts?: number;
    backoffMs?: (attempt: number) => number;
    lookup?: Lookup;
  };
}

export interface ResolvedAlertsOptions extends AlertsModuleOptions {
  publicUrl: string | undefined;
  allowedHosts: readonly string[];
  retentionDays: number;
}
