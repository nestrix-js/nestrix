// Integrations that are off install nothing; disposing removes every subscription and stops spans
// (backlog P3-01 item 7). Global state: the test provider (outbound-helpers.ts). Runs in its own
// worker, so `pg` is not in the module cache unless a test here loads it.
import dc from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  IOREDIS_CHANNELS,
  MYSQL2_CHANNELS,
} from "../../src/integrations/channels.js";
import { installIntegrations } from "../../src/integrations/index.js";
import { pgActive } from "../../src/integrations/pg.js";
import { recordingDiagnostics } from "../otel-helpers.js";
import { inParent, resolved, setupTestTracing } from "../outbound-helpers.js";
import { address, dbSpans, skipReason, waitUntil } from "./helpers.js";

const require = createRequire(import.meta.url);
const PG_INDEX = /[\\/]node_modules[\\/]pg[\\/]lib[\\/]index\.js$/;
const ALL_CHANNELS = [
  ...Object.values(MYSQL2_CHANNELS),
  ...Object.values(IOREDIS_CHANNELS),
];
const { exporter } = setupTestTracing();
const diagnostics = recordingDiagnostics();

const subscribed = () =>
  ALL_CHANNELS.filter((name) => dc.tracingChannel(name).hasSubscribers);

afterEach(() => exporter.reset());

describe("integrations off", () => {
  it("all off: pg is neither loaded nor wrapped, and no channel has a subscriber", () => {
    const dispose = installIntegrations(
      resolved({ integrations: { pg: false, mysql2: false, ioredis: false } }),
      diagnostics,
    );
    try {
      expect(
        Object.keys(require.cache).filter((p) => PG_INDEX.test(p)),
      ).toEqual([]);
      expect(pgActive()).toBe(false);
      expect(subscribed()).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("defaults: mysql2 and ioredis stay unsubscribed (D-49)", () => {
    const dispose = installIntegrations(resolved(), diagnostics);
    try {
      expect(subscribed()).toEqual([]);
      expect(pgActive()).toBe(true);
    } finally {
      dispose();
    }
    expect(pgActive()).toBe(false);
  });

  it("on, then disposed: every channel subscription is removed", () => {
    const dispose = installIntegrations(
      resolved({ integrations: { pg: false, mysql2: true, ioredis: true } }),
      diagnostics,
    );
    expect(subscribed()).toEqual(ALL_CHANNELS);
    dispose();
    dispose(); // idempotent
    expect(subscribed()).toEqual([]);
  });

  it("two installations: the subscription stays until both are disposed", () => {
    const options = resolved({ integrations: { pg: false, ioredis: true } });
    const first = installIntegrations(options, diagnostics);
    const second = installIntegrations(options, diagnostics);
    first();
    expect(subscribed()).toEqual(Object.values(IOREDIS_CHANNELS));
    second();
    expect(subscribed()).toEqual([]);
  });
});

describe.skipIf(skipReason("postgres") !== undefined)("pg disposed", () => {
  it("a wrapped pg passes straight through once the integration is disposed", async () => {
    const dispose = installIntegrations(resolved(), diagnostics);
    dispose();
    // biome-ignore lint/suspicious/noExplicitAny: structural use only
    const pg = require("pg") as any;
    expect(
      pg.Client.prototype.query[Symbol.for("nestrix.pg.wrapped")],
    ).toBeTypeOf("function");
    const a = address("postgres");
    const config = {
      host: a.host,
      port: a.port,
      user: "postgres",
      database: "nestrix",
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural use only
    let client: any;
    await waitUntil(
      async () => {
        const c = new pg.Client(config);
        await c.connect();
        client = c;
      },
      30_000,
      "postgres",
    );
    try {
      const { result } = await inParent(() => client.query("SELECT 1 AS one"));
      expect(result.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.end();
    }
    expect(dbSpans(exporter.getFinishedSpans())).toEqual([]);
  }, 40_000);
});
