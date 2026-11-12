import { describe, expect, it } from "vitest";

import { ApiRequestError } from "@/lib/api";
import {
  captureStatus,
  durationLabel,
  isActive,
  shortInstanceId,
} from "@/views/profiler/remote-format";
import {
  remoteStartProblem,
  retryRemaining,
} from "@/views/profiler/start-problem";

const capture = (over: Partial<Parameters<typeof captureStatus>[0]> = {}) => ({
  state: "running" as const,
  requestedAtUnixMs: 1_000,
  startedAtUnixMs: 10_000,
  durationMs: 30_000,
  ...over,
});

describe("remote profiler helpers", () => {
  it("shortens an instance id to 8 characters", () => {
    expect(shortInstanceId("3f2a9c1e-77aa-4b1b-9d2e-000000000001")).toBe(
      "3f2a9c1e",
    );
    expect(shortInstanceId("abc")).toBe("abc");
  });

  it("labels durations", () => {
    expect(durationLabel(15)).toBe("15 seconds");
    expect(durationLabel(60)).toBe("1 minute");
    expect(durationLabel(120)).toBe("2 minutes");
  });

  it("treats pending and running as active", () => {
    expect(isActive({ state: "pending" })).toBe(true);
    expect(isActive({ state: "running" })).toBe(true);
    for (const state of ["done", "failed", "expired"] as const) {
      expect(isActive({ state })).toBe(false);
    }
  });

  it("describes a pending capture as waiting for the next check-in", () => {
    expect(captureStatus(capture({ state: "pending" }), 5_000)).toEqual({
      label: "Waiting for the instance (checks in every 15 s)",
      progress: null,
    });
  });

  it("counts down while running and says Uploading after the duration", () => {
    expect(captureStatus(capture(), 22_000)).toEqual({
      label: "Capturing… 18 s left",
      progress: 12_000,
    });
    expect(captureStatus(capture(), 40_000).label).toBe("Uploading");
    expect(captureStatus(capture(), 70_000).label).toBe("Uploading");
  });

  it("falls back to the request time when the start time is missing", () => {
    expect(
      captureStatus(capture({ startedAtUnixMs: null }), 11_000).label,
    ).toBe("Capturing… 20 s left");
  });

  it("counts a Retry-After down from when it arrived, never below zero", () => {
    expect(retryRemaining(7, 1_000, 1_000)).toBe(7);
    expect(retryRemaining(7, 1_000, 3_500)).toBe(5);
    expect(retryRemaining(7, 1_000, 20_000)).toBe(0);
  });

  it("explains each refused remote start", () => {
    const err = (status: number, code: string) =>
      new ApiRequestError(status, code, "server text");
    expect(remoteStartProblem(err(403, "forbidden"), "ab12", null)).toContain(
      "HTTPS or localhost",
    );
    expect(remoteStartProblem(err(404, "not_found"), "ab12", null)).toContain(
      "has not checked in",
    );
    expect(remoteStartProblem(err(409, "conflict"), "ab12", null)).toContain(
      "already pending or running",
    );
    expect(
      remoteStartProblem(err(429, "too_many_requests"), "ab12", 4),
    ).toContain("available again in 4 s");
    expect(remoteStartProblem(err(500, "x"), "ab12", null)).toBe("server text");
  });
});
