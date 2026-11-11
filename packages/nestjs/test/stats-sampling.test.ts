// Global state: no host SDK. Nestrix owns the provider at sampleRate 0.1, export off.
// P2-04 "Done when": route statistics are counted before sampling (D-35) on all three adapters.
import type { INestApplication } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import {
  type AdapterName,
  bootOwned,
  counts,
  errorCounts,
  newHarness,
  StatsController,
  seen,
  sendAll,
  statsModule,
} from "./stats-fixture.js";

const ADAPTERS: AdapterName[] = ["express", "fastify", "node"];

let app: INestApplication | undefined;
beforeEach(() => {
  resetDiagnosticsForTests();
  seen.handled = 0;
  seen.recording = 0;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe.each(ADAPTERS)(
  "route statistics at sampleRate 0.1 on %s",
  (adapter) => {
    it("counts every request per route, sampled or not: 400 requests over three routes, with a 404 and a thrown 500", async () => {
      const harness = newHarness();
      const booted = await bootOwned(
        adapter,
        statsModule({
          controllers: [StatsController],
          dashboard: harness.dashboard,
          telemetry: true,
          mount: false,
          options: { export: { otlp: false }, sampleRate: 0.1 },
        }),
      );
      app = booted.app;

      const paths: string[] = [];
      for (let i = 0; i < 250; i++) paths.push(`/s/ok/${i}`);
      for (let i = 0; i < 100; i++) paths.push("/s/boom");
      for (let i = 0; i < 50; i++) paths.push(`/missing/${i}`);
      expect(paths).toHaveLength(400);
      const statuses = await sendAll(booted.baseUrl, paths);
      expect(statuses.filter((s) => s === 200)).toHaveLength(250);
      expect(statuses.filter((s) => s === 500)).toHaveLength(100);
      expect(statuses.filter((s) => s === 404)).toHaveLength(50);

      const expected = {
        "GET /s/ok/:id": 250,
        "GET /s/boom": 100,
        "GET (unmatched)": 50,
      };
      // Recorded at the raw response's `close`, which may follow the client's read by a tick.
      await expect.poll(() => counts(harness.stats)).toEqual(expected);
      expect(errorCounts(harness.stats)).toEqual({
        "GET /s/ok/:id": 0,
        "GET /s/boom": 100,
        "GET (unmatched)": 0,
      });

      // Sampling really applied: most handler runs saw a non-recording Nestrix span.
      expect(seen.handled).toBe(350);
      expect(seen.recording).toBeGreaterThan(0);
      expect(seen.recording).toBeLessThan(350 * 0.25);
      expect([...getFailureCounts().keys()]).toEqual([]);
    });
  },
);
