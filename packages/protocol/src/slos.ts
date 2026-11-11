/**
 * SLO API of the standalone server (`/api/v1/slos`, docs/backlog/phase-7.md P7-04).
 * Types only: this file adds no runtime export.
 */

/** `availability`: share of requests that are not errors. `latency`: share faster than the threshold. */
export type SloKind = "availability" | "latency";

/** What a stored SLO is, and the fields of `POST /api/v1/slos` (without `id` and the times). */
export interface SloDefinition {
  name: string;
  service: string;
  /** `null`: every route of the service. */
  route: string | null;
  kind: SloKind;
  /** Milliseconds; present for `latency`, `null` for `availability`. */
  latencyThresholdMs: number | null;
  /** The target share of good requests, strictly between 0 and 1 (0.999). */
  objective: number;
  /** Rolling window: 7 or 30 days. */
  windowDays: 7 | 30;
}

/** The SLO's computed state over its window. `null` means no requests in the period. */
export interface SloStatus {
  totalRequests: number;
  goodRequests: number;
  badRequests: number;
  /** good / total as a fraction, or `null` without requests. */
  attainment: number | null;
  errorBudget: {
    /** (1 - objective) * total: the bad requests the window allows. */
    totalRequests: number;
    /** total - bad; negative once the budget is overspent. */
    remainingRequests: number;
    /** remaining / total budget; at most 1, negative when overspent. `null` without requests. */
    remainingFraction: number | null;
  };
  /** Bad fraction / (1 - objective) over the last hour and 6 hours; `null` without requests. */
  burnRate: { "1h": number | null; "6h": number | null };
  /** True when `attainment` is below the objective. */
  breached: boolean;
}

export interface Slo extends SloDefinition {
  /** Decimal string of the numeric id. */
  id: string;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  status: SloStatus;
}

/** `POST /api/v1/slos`. Unknown fields are refused (400). `latencyThresholdMs` is required for `latency`, refused for `availability`. */
export interface SloCreate {
  name: string;
  service: string;
  route?: string | null;
  kind: SloKind;
  latencyThresholdMs?: number;
  objective: number;
  windowDays: 7 | 30;
}

/** `PATCH /api/v1/slos/:id`: any subset of the create fields. */
export type SloUpdate = Partial<SloCreate>;

export interface SloListResponse {
  slos: Slo[];
}
