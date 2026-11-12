/**
 * Validation of the small JSON bodies of remote profiling (P10-02). Pure; never throws.
 *
 * - Check-in (from an instance, unknown fields ignored): `service` and `instanceId` non-empty
 *   strings of at most 256 characters without control characters (400 otherwise); `version`,
 *   `host`, `runtime`, `sdkVersion` kept when strings, control characters removed, cut to 256;
 *   `pid` kept when a whole number from 0 to 2^31 - 1. `runtimeSample` (P15-03, D-80): each figure
 *   kept when a finite number from 0 to its bound (`RUNTIME_BOUNDS`), dropped otherwise; the whole
 *   sample dropped when it is not an object, `sampledAtUnixMs` is not a positive whole number, or
 *   no figure is left. A bad sample never fails the check-in.
 * - Failure report (from an instance, unknown fields ignored): `message`, a string, control
 *   characters removed, cut to 500.
 * - Start (from the dashboard, unknown fields refused like the embedded `POST profiles`):
 *   `service`, `instanceId` as in a check-in, `durationSeconds` a whole number from 1 to 120,
 *   default 30.
 */
import type { CheckIn, CheckInRuntime } from "./store.js";

export const MAX_IDENTITY_LENGTH = 256;
export const MAX_FIELD_LENGTH = 256;
export const MAX_FAILURE_MESSAGE_LENGTH = 500;
export const DEFAULT_DURATION_SECONDS = 30;
export const MAX_DURATION_SECONDS = 120;
/** Largest accepted value of each runtime figure; anything above is dropped. */
export const RUNTIME_BOUNDS = Object.freeze({
  /** 1,000 cores' worth. */
  cpuPercent: 100_000,
  /** One hour. */
  eventLoopP99Ms: 3_600_000,
  /** 2^50 bytes (1 PiB). */
  heapUsedBytes: 2 ** 50,
  rssBytes: 2 ** 50,
});
const START_FIELDS = new Set(["service", "instanceId", "durationSeconds"]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Control characters removed, cut to `max` characters, lone surrogates replaced. */
export function cleanText(value: string, max: number): string {
  return value.replace(CONTROL, "").slice(0, max).toWellFormed();
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = cleanText(value, MAX_FIELD_LENGTH).trim();
  return cleaned === "" ? null : cleaned;
}

function identity(
  value: unknown,
  name: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTITY_LENGTH ||
    HAS_CONTROL.test(value) ||
    !value.isWellFormed()
  ) {
    return {
      ok: false,
      message: `${name} must be a string of 1 to ${MAX_IDENTITY_LENGTH} characters without control characters.`,
    };
  }
  return { ok: true, value };
}

function figure(value: unknown, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

/** The check-in's `runtimeSample`, or `null` when absent or unusable. Never throws. */
export function parseRuntimeSample(value: unknown): CheckInRuntime | null {
  if (!isObject(value)) return null;
  const at = value.sampledAtUnixMs;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) {
    return null;
  }
  const sample: CheckInRuntime = {
    cpuPercent: figure(value.cpuPercent, RUNTIME_BOUNDS.cpuPercent),
    eventLoopP99Ms: figure(value.eventLoopP99Ms, RUNTIME_BOUNDS.eventLoopP99Ms),
    heapUsedBytes: figure(value.heapUsedBytes, RUNTIME_BOUNDS.heapUsedBytes),
    rssBytes: figure(value.rssBytes, RUNTIME_BOUNDS.rssBytes),
  };
  return Object.values(sample).every((v) => v === null) ? null : sample;
}

export function parseCheckIn(
  value: unknown,
): { ok: true; checkIn: CheckIn } | { ok: false; message: string } {
  try {
    if (!isObject(value)) {
      return { ok: false, message: "The body must be a JSON object." };
    }
    const service = identity(value.service, "service");
    if (!service.ok) return service;
    const instanceId = identity(value.instanceId, "instanceId");
    if (!instanceId.ok) return instanceId;
    const pid =
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid >= 0 &&
      value.pid <= 2_147_483_647
        ? value.pid
        : null;
    return {
      ok: true,
      checkIn: {
        service: service.value,
        instanceId: instanceId.value,
        version: optionalText(value.version),
        host: optionalText(value.host),
        pid,
        runtime: optionalText(value.runtime),
        sdkVersion: optionalText(value.sdkVersion),
        runningCaptureId: optionalText(value.runningCaptureId),
        runtimeSample: parseRuntimeSample(value.runtimeSample),
      },
    };
  } catch {
    return { ok: false, message: "The body could not be read." };
  }
}

export function parseFailed(
  value: unknown,
): { ok: true; message: string } | { ok: false; message: string } {
  try {
    if (!isObject(value) || typeof value.message !== "string") {
      return {
        ok: false,
        message: "Send a JSON object with a message string.",
      };
    }
    const message = cleanText(value.message, MAX_FAILURE_MESSAGE_LENGTH).trim();
    return {
      ok: true,
      message: message === "" ? "The instance reported a failure." : message,
    };
  } catch {
    return { ok: false, message: "The body could not be read." };
  }
}

export function parseStart(
  value: unknown,
):
  | { ok: true; service: string; instanceId: string; durationSeconds: number }
  | { ok: false; message: string } {
  try {
    if (!isObject(value)) {
      return {
        ok: false,
        message:
          'Send a JSON object, such as {"service":"orders","instanceId":"…","durationSeconds":30}.',
      };
    }
    for (const key of Object.keys(value)) {
      if (!START_FIELDS.has(key)) {
        return {
          ok: false,
          message: `Unknown field ${JSON.stringify(key.slice(0, 64))}.`,
        };
      }
    }
    const service = identity(value.service, "service");
    if (!service.ok) return service;
    const instanceId = identity(value.instanceId, "instanceId");
    if (!instanceId.ok) return instanceId;
    const given = value.durationSeconds;
    if (given === undefined) {
      return {
        ok: true,
        service: service.value,
        instanceId: instanceId.value,
        durationSeconds: DEFAULT_DURATION_SECONDS,
      };
    }
    if (
      typeof given !== "number" ||
      !Number.isInteger(given) ||
      given < 1 ||
      given > MAX_DURATION_SECONDS
    ) {
      return {
        ok: false,
        message: `durationSeconds must be a whole number from 1 to ${MAX_DURATION_SECONDS}.`,
      };
    }
    return {
      ok: true,
      service: service.value,
      instanceId: instanceId.value,
      durationSeconds: given,
    };
  } catch {
    return { ok: false, message: "The request body could not be read." };
  }
}
