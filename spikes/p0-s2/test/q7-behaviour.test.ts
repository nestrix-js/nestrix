import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  dbs,
  nodeBinaries,
  requireBuilt,
  runNode,
  skipNote,
  spikeRoot,
} from "./helpers.js";

// Q7: run the same library calls with nothing enabled (off), with the instrumentation
// (on), with a throw injected into every guarded body (faults), and with empty
// TracingChannel subscribers and no Nestrix code at all (bare). Any observation that
// differs from `off` is a behaviour change.

requireBuilt();

interface Q7 {
  meta: {
    mode: string;
    node: string;
    failures: Record<string, number>;
    spanCount: number;
  };
  obs: Record<string, unknown>;
}

const anyDb = !!(dbs.pg || dbs.mysql || dbs.redis);

function runMode(
  mode: string,
  env: Record<string, string> = {},
  node?: string,
) {
  return runNode<Q7>(join(spikeRoot, "dist/src/q7/behaviour.js"), {
    marker: "__Q7__",
    node,
    env: {
      MODE: mode,
      PG_URL: dbs.pg,
      MYSQL_URL: dbs.mysql,
      REDIS_URL: dbs.redis,
      ...env,
    },
  });
}

function diff(a: Q7, b: Q7): string[] {
  return Object.keys(a.obs).filter(
    (k) => JSON.stringify(a.obs[k]) !== JSON.stringify(b.obs[k]),
  );
}

/** Differences that come from mysql2 / ioredis themselves once anything subscribes. */
const LIBRARY_DIFFS = [
  ...(dbs.mysql
    ? [
        "mysql.emitter.noListener.listenerCountAfterSubmit",
        "mysql.emitter.noListener.uncaught",
        "mysql.afterNoListener",
      ]
    : []),
  ...(dbs.redis ? ["redis.unawaited.unhandled"] : []),
];

describe.skipIf(!anyDb)(skipNote("Q7 behaviour", anyDb), () => {
  describe.each(nodeBinaries())("Node $label", ({ bin }) => {
    const runs: Record<string, Q7> = {};
    beforeAll(async () => {
      for (const mode of [
        "off",
        "on",
        "faults",
        "bare",
        "plain-start",
        "tc-start-only",
        "pool-connect-only",
      ]) {
        const out = await runMode(mode, {}, bin);
        expect(out.result, out.stderr).toBeDefined();
        runs[mode] = out.result as Q7;
      }
    });

    it("instrumentation was really active in `on` and really failing in `faults`", () => {
      expect(runs.off?.meta.spanCount).toBe(0);
      expect(runs.on?.meta.spanCount).toBeGreaterThan(20);
      expect(runs.on?.meta.failures).toEqual({});
      expect(runs.faults?.meta.spanCount).toBe(0);
      expect(
        Object.keys(runs.faults?.meta.failures ?? {}).length,
      ).toBeGreaterThan(0);
    });

    it.skipIf(!dbs.pg)(
      "pg: no observation differs (callbacks, promises, sync throw, errors, unhandled rejection, user-callback throw, cursor, stream, pool)",
      () => {
        const pgDiffs = (m: string) =>
          diff(runs.off as Q7, runs[m] as Q7).filter((k) =>
            k.startsWith("pg."),
          );
        expect(pgDiffs("on")).toEqual([]);
        expect(pgDiffs("faults")).toEqual([]);
        expect(runs.off?.obs["pg.unawaited.unhandled"]).toHaveLength(1);
        expect(runs.off?.obs["pg.callbackThrows.uncaught"]).toEqual([
          "Error: thrown by user callback",
        ]);
        expect(runs.off?.obs["pg.stream.bad.errorListeners"]).toBe(0);
      },
    );

    it("mysql2/ioredis: the only differences are the libraries' own, and they appear with bare empty subscribers too", () => {
      const nonPg = (m: string) =>
        diff(runs.off as Q7, runs[m] as Q7).filter((k) => !k.startsWith("pg."));
      expect(nonPg("on").sort()).toEqual([...LIBRARY_DIFFS].sort());
      expect(nonPg("faults").sort()).toEqual([...LIBRARY_DIFFS].sort());
      expect(nonPg("bare").sort()).toEqual([...LIBRARY_DIFFS].sort());
    });

    it("F1: no subscription style avoids it: a plain `tracing:<name>:start` subscriber or a start-only TracingChannel subscriber triggers the same changes", () => {
      // Both libraries test the TracingChannel's combined hasSubscribers (ioredis
      // built/tracing.js shouldTrace: `channel.hasSubscribers !== false`; mysql2
      // lib/tracing.js shouldTrace), which is true once any sub-channel has one.
      const nonPg = (m: string) =>
        diff(runs.off as Q7, runs[m] as Q7).filter((k) => !k.startsWith("pg."));
      expect(nonPg("plain-start").sort()).toEqual([...LIBRARY_DIFFS].sort());
      expect(nonPg("tc-start-only").sort()).toEqual([...LIBRARY_DIFFS].sort());
    });

    it("option (d): subscribing only to mysql2:pool:connect changes nothing (pg and redis unaffected too)", () => {
      expect(diff(runs.off as Q7, runs["pool-connect-only"] as Q7)).toEqual([]);
    });

    it.skipIf(!dbs.mysql)(
      "mysql2 finding: an event-emitter query that fails with no 'error' listener crashes the host (uncaught) without subscribers, and is silently swallowed with one",
      () => {
        expect(runs.off?.obs["mysql.emitter.noListener.uncaught"]).toHaveLength(
          1,
        );
        expect(runs.on?.obs["mysql.emitter.noListener.uncaught"]).toEqual([]);
        expect(
          runs.bare?.obs["mysql.emitter.noListener.listenerCountAfterSubmit"],
        ).toBe(1);
      },
    );

    it.skipIf(!dbs.redis)(
      "ioredis finding: an unawaited failing command raises unhandledRejection without subscribers, and nothing with one",
      () => {
        expect(runs.off?.obs["redis.unawaited.unhandled"]).toHaveLength(1);
        expect(runs.on?.obs["redis.unawaited.unhandled"]).toEqual([]);
        expect(runs.bare?.obs["redis.unawaited.unhandled"]).toEqual([]);
      },
    );
  });

  describe("F1 direction under Node's default --unhandled-rejections=throw: crash without a subscriber, silence with one", () => {
    const run = (lib: string, sub: string) =>
      runNode<{ survived: boolean }>(
        join(spikeRoot, "scripts/crash-direction.mjs"),
        {
          marker: "__CRASH__",
          args: [lib, sub],
          env: { MYSQL_URL: dbs.mysql, REDIS_URL: dbs.redis },
        },
      );
    it.skipIf(!dbs.redis)("ioredis: unawaited failing command", async () => {
      const none = await run("ioredis", "none");
      expect(none.code).toBe(1);
      expect(none.stderr).toMatch(/WRONGTYPE/);
      const sub = await run("ioredis", "plain-start");
      expect(sub.code).toBe(0);
      expect(sub.result?.survived).toBe(true);
    });
    it.skipIf(!dbs.mysql)(
      "mysql2: failing event-emitter query with no 'error' listener",
      async () => {
        const none = await run("mysql2", "none");
        expect(none.code).toBe(1);
        expect(none.stderr).toMatch(/ER_NO_SUCH_TABLE|doesn't exist/);
        const sub = await run("mysql2", "plain-start");
        expect(sub.code).toBe(0);
        expect(sub.result?.survived).toBe(true);
      },
    );
  });

  it.skipIf(!dbs.redis)("ioredis 5.11.1 behaves the same way", async () => {
    const off = (await runMode("off", { REDIS_LIB: "ioredis5" })).result as Q7;
    const bare = (await runMode("bare", { REDIS_LIB: "ioredis5" }))
      .result as Q7;
    expect(off.obs["redis.lib"]).toBe("ioredis5");
    expect(off.obs["redis.unawaited.unhandled"]).toHaveLength(1);
    expect(bare.obs["redis.unawaited.unhandled"]).toEqual([]);
  });
});
