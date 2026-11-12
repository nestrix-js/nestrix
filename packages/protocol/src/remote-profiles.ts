/**
 * Remote CPU profiling through the standalone server (D-76, docs/backlog/phase-10.md).
 *
 * The app instance makes every request; the server never connects to an instance.
 *
 * Instance side, on the ingest port, authenticated with an ingest key like `/v1/traces`:
 * - `POST /v1/nestrix/check-in` with `CheckInRequest` as JSON: `200` with `CheckInResponse`.
 * - `POST /v1/nestrix/profiles/<id>` with the `.cpuprofile` JSON as the body (gzip allowed):
 *   `204`. Only the instance the capture was requested for may upload it, and only while it is
 *   `running`.
 * - `POST /v1/nestrix/profiles/<id>/failed` with `CaptureFailedRequest` as JSON: `204`.
 *
 * Dashboard side, under the query API (`/api/v1`):
 * - `GET instances[?service=]`: `InstanceListResponse` (any reader: session or API token).
 * - `POST remote-profiles` with `RemoteProfileStartRequest`: `202` with `RemoteProfileSummary`
 *   (admin session only, `Sec-Fetch-Site: same-origin` and a matching `Origin`; API tokens stay
 *   read-only, D-74). `404` unknown or stale instance; `409` with `RemoteProfileConflictError`
 *   while one is pending or running for that instance; `429` with `ProfileCooldownError` within
 *   10 s of that instance's previous capture.
 * - `GET remote-profiles[?service=&instanceId=]`: `RemoteProfileListResponse`.
 * - `GET remote-profiles/<id>`: `RemoteProfileDetail` (`topFunctions` and `flame` present only
 *   when `state` is `done`).
 * - `GET remote-profiles/<id>/download`: the `.cpuprofile` as an attachment.
 */
import type { FlameNode, ProfileFunction } from "./profiles.js";
import type { ApiError } from "./types.js";

/** What an instance sends on every check-in. Unknown fields are ignored. */
export interface CheckInRequest {
  /** `service.name` of the instance's resource. */
  service: string;
  /** `service.instance.id` of the instance's resource (a random UUID per process). */
  instanceId: string;
  /** `service.version`, when set. */
  version?: string;
  /** `host.name`, when known. */
  host?: string;
  pid?: number;
  /** `process.version`, e.g. `v26.1.0`. */
  runtime?: string;
  /** Version of `@nestrix-js/nestjs`. */
  sdkVersion?: string;
  /** Id of the capture this instance is running now, if any. */
  runningCaptureId?: string;
}

/** A capture the server asks the instance to run. */
export interface CaptureOrder {
  /** 16 lowercase hex characters. */
  id: string;
  /** 1000 to 120000. */
  durationMs: number;
}

/** Answer to a check-in. */
export interface CheckInResponse {
  /** Present when a capture is waiting for this instance. */
  capture?: CaptureOrder;
  /** When to check in next; the instance clamps it to 5 s to 5 min. Default 15000. */
  nextCheckInMs: number;
}

/** Body of `POST /v1/nestrix/profiles/<id>/failed`. */
export interface CaptureFailedRequest {
  /** Short reason, cut to 500 characters by the server (`busy`, `cooldown`, the error message). */
  message: string;
}

/** An instance that checked in recently (opted in with `export.profiler: true`). */
export interface InstanceSummary {
  service: string;
  instanceId: string;
  version: string | null;
  host: string | null;
  pid: number | null;
  runtime: string | null;
  sdkVersion: string | null;
  firstSeenUnixMs: number;
  lastSeenUnixMs: number;
  /** The pending or running capture for this instance, if any. */
  capture: RemoteProfileSummary | null;
}

/** `GET api/v1/instances`. Instances seen in the last 2 minutes, newest check-in first. */
export interface InstanceListResponse {
  instances: InstanceSummary[];
}

/** `POST api/v1/remote-profiles`. Unknown fields are refused (400). */
export interface RemoteProfileStartRequest {
  service: string;
  instanceId: string;
  /** Whole seconds, 1 to 120. Default 30. */
  durationSeconds?: number;
}

/**
 * - `pending`: requested, waiting for the instance's next check-in (expires after 60 s).
 * - `running`: handed to the instance; it is capturing or uploading.
 * - `done`: profile stored.
 * - `failed`: the instance reported a failure.
 * - `expired`: never picked up, or no upload within duration + 60 s.
 */
export type RemoteProfileState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "expired";

export interface RemoteProfileSummary {
  id: string;
  service: string;
  instanceId: string;
  /** `service.version` of the instance at request time. */
  version: string | null;
  state: RemoteProfileState;
  requestedAtUnixMs: number;
  /** When the instance received the order. */
  startedAtUnixMs: number | null;
  finishedAtUnixMs: number | null;
  /** Requested length. */
  durationMs: number;
  /** Set when `state` is `done`. */
  actualDurationMs: number | null;
  samples: number | null;
  bytes: number | null;
  /** Set when `state` is `failed` or `expired`. */
  error: string | null;
}

/** `GET api/v1/remote-profiles`. Newest first, at most 50. */
export interface RemoteProfileListResponse {
  profiles: RemoteProfileSummary[];
}

/** `GET api/v1/remote-profiles/<id>`. */
export interface RemoteProfileDetail extends RemoteProfileSummary {
  /** Same shape as the embedded profiler's; present when `state` is `done`. */
  topFunctions?: ProfileFunction[];
  flame?: FlameNode;
}

/** `409` answer: a capture is already pending or running for this instance. */
export interface RemoteProfileConflictError extends ApiError {
  capture: RemoteProfileSummary;
}
