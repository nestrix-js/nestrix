import type { RouteStatsResponse } from "../src/index.js";

const from = 1_794_399_100_000;
const bucketMs = 180_000;

export const routes = {
  windowMinutes: 15,
  bucketMs,
  fromUnixMs: from,
  toUnixMs: from + 5 * bucketMs,
  routes: [
    {
      method: "GET",
      route: "/orders/:id",
      count: 140,
      errors: 6,
      p50Ms: 18.2,
      p95Ms: 96.4,
      p99Ms: 182.4,
      maxMs: 240.9,
      series: [
        { timeUnixMs: from, count: 30, errors: 0, p50Ms: 17.5, p95Ms: 80.1 },
        {
          timeUnixMs: from + bucketMs,
          count: 28,
          errors: 1,
          p50Ms: 18.0,
          p95Ms: 92.2,
        },
        {
          timeUnixMs: from + 2 * bucketMs,
          count: 25,
          errors: 3,
          p50Ms: 19.1,
          p95Ms: 110.7,
        },
        {
          timeUnixMs: from + 3 * bucketMs,
          count: 27,
          errors: 2,
          p50Ms: 18.6,
          p95Ms: 101.3,
        },
        {
          timeUnixMs: from + 4 * bucketMs,
          count: 30,
          errors: 0,
          p50Ms: 18.3,
          p95Ms: 88.9,
        },
      ],
    },
    {
      method: "POST",
      route: "/orders",
      count: 12,
      errors: 0,
      p50Ms: 41.0,
      p95Ms: 120.5,
      p99Ms: 120.5,
      maxMs: 120.5,
      series: [
        { timeUnixMs: from, count: 0, errors: 0 },
        {
          timeUnixMs: from + bucketMs,
          count: 4,
          errors: 0,
          p50Ms: 40.2,
          p95Ms: 88.0,
        },
        {
          timeUnixMs: from + 2 * bucketMs,
          count: 8,
          errors: 0,
          p50Ms: 41.4,
          p95Ms: 120.5,
        },
        { timeUnixMs: from + 3 * bucketMs, count: 0, errors: 0 },
        { timeUnixMs: from + 4 * bucketMs, count: 0, errors: 0 },
      ],
    },
  ],
} satisfies RouteStatsResponse;
