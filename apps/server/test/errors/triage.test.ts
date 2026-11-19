/**
 * Error triage against a real PostgreSQL (issue #26, D-103): the sync fills `error_groups`, the
 * resolve/ignore/reopen routes change it, a resolved group regresses in a newer release and a
 * `new_error_group` rule notifies once, ignored groups stay out of lists and alerts, the state
 * survives a restart and the deletion of the span partitions, and the writes are admin-only and
 * same-origin only.
 */
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type {
  AlertRuleCreateResponse,
  AlertWebhookPayload,
  ErrorGroup,
  ErrorGroupsResponse,
  ErrorGroupTriageResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlertEvaluator } from "../../src/alerts/evaluator.js";
import {
  ALERTS_OPTIONS,
  type ResolvedAlertsOptions,
} from "../../src/alerts/tokens.js";
import { WebhookSender } from "../../src/alerts/webhook.js";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/bootstrap.js";
import type { ServerConfig } from "../../src/config.js";
import { SERVER_CONFIG } from "../../src/config.module.js";
import { ERROR_SYNC_OPTIONS, ErrorGroupSync } from "../../src/errors/sync.js";
import { ensurePartitions, utcDay } from "../../src/storage/partitions.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import { type Receiver, startReceiver } from "../alerts/helpers.js";
import { ADMIN_PW, SESSION_SECRET, signedCookie } from "../auth/helpers.js";
import { lastServer, testConfig } from "../ingest/helpers.js";
import {
  batch,
  createTestDb,
  hex,
  noDatabase,
  skipReason,
  span,
  type TestDb,
} from "../storage/helpers.js";

interface Server {
  app: NestExpressApplication;
  baseUrl: string;
  cookie: string;
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  json<T>(path: string): Promise<T>;
  sync: ErrorGroupSync;
  evaluator: AlertEvaluator;
  /** What the evaluator reported (its logger is off), and runs that were skipped. */
  evalErrors: string[];
  close(): Promise<void>;
}

/** The whole server with both timers off: the tests run the sync and the evaluator themselves. */
async function start(databaseUrl: string): Promise<Server> {
  const config = testConfig({
    DATABASE_URL: databaseUrl,
    NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
    NESTRIX_SESSION_SECRET: SESSION_SECRET,
    NESTRIX_WEBHOOK_ALLOWED_HOSTS: "127.0.0.1",
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  })
    .overrideProvider(ALERTS_OPTIONS)
    .useFactory({
      inject: [SERVER_CONFIG],
      factory: (c: ServerConfig): ResolvedAlertsOptions => ({
        schedule: false,
        webhook: { backoffMs: () => 10, timeoutMs: 1000 },
        publicUrl: c.alerts.publicUrl,
        allowedHosts: c.alerts.allowedHosts,
        retentionDays: c.retentionDays,
      }),
    })
    .overrideProvider(ERROR_SYNC_OPTIONS)
    .useValue({ schedule: false, lagMs: 0 })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, config);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  lastServer.port = port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cookie = signedCookie(undefined, undefined, undefined, port);
  // The evaluator reports through the Nest logger, which is off here: keep what it says.
  const evalErrors: string[] = [];
  (
    app.get(AlertEvaluator) as unknown as { onError: (m: string) => void }
  ).onError = (m) => {
    evalErrors.push(m);
  };
  const call: Server["call"] = (method, path, body, headers = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      redirect: "manual",
      headers: {
        cookie,
        origin: baseUrl,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    app,
    baseUrl,
    cookie,
    call,
    json: async <T>(path: string) => (await call("GET", path)).json() as T,
    sync: app.get(ErrorGroupSync),
    evaluator: app.get(AlertEvaluator),
    evalErrors,
    close: async () => {
      app.getHttpServer().closeAllConnections();
      await app.close();
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(noDatabase)(`error triage ${skipReason}`, () => {
  let db: TestDb;
  let server: Server;
  let receiver: Receiver;
  let ruleId: string;

  /** One failing request: a root span with an exception, in `release`. */
  async function fail(
    message: string,
    release: string,
    route = "/orders",
    service = "shop",
    environment?: string,
  ): Promise<void> {
    const traceId = hex(16);
    const rootId = hex(8);
    const now = Date.now();
    await server.app.get(PostgresIngestSink).write(
      batch(
        service,
        [
          span({
            traceId,
            spanId: rootId,
            name: `GET ${route}`,
            kind: "server",
            startMs: now,
            durationMs: 5,
            attributes: {
              "http.request.method": "GET",
              "http.route": route,
              "http.response.status_code": 500,
            },
            status: { code: "error" },
            events: [
              {
                name: "exception",
                timeUnixNano: BigInt(now) * 1_000_000n,
                attributes: {
                  "exception.type": "Error",
                  "exception.message": message,
                  "exception.stacktrace": `Error: ${message}\n    at x (a.js:1:1)`,
                },
              },
            ],
          }),
        ],
        {
          "service.version": release,
          ...(environment === undefined
            ? {}
            : { "deployment.environment.name": environment }),
        },
      ),
    );
  }

  const groups = (query = "") =>
    server.json<ErrorGroupsResponse>(
      `/api/v1/errors/groups?windowMinutes=15${query}`,
    );
  const find = (
    r: ErrorGroupsResponse,
    pattern: string,
  ): ErrorGroup | undefined => r.groups.find((g) => g.pattern === pattern);
  const act = (
    action: string,
    key: string,
    service?: string,
    environment?: string,
  ) =>
    server.call("POST", `/api/v1/errors/groups/${action}`, {
      key,
      ...(service === undefined ? {} : { service }),
      ...(environment === undefined ? {} : { environment }),
    });
  const payloads = (): AlertWebhookPayload[] =>
    receiver.requests.map((r) => JSON.parse(r.body) as AlertWebhookPayload);
  /** Sync, then evaluate; waits for the deliveries. */
  async function settle(): Promise<void> {
    const synced = await server.sync.runOnce();
    if (synced.skipped !== undefined)
      server.evalErrors.push(`sync skipped: ${synced.skipped}`);
    const run = await server.evaluator.runOnce();
    if (run.skipped !== undefined)
      server.evalErrors.push(`evaluator skipped: ${run.skipped}`);
    await Promise.all(run.deliveries);
  }

  beforeAll(async () => {
    db = await createTestDb("errtriage");
    receiver = await startReceiver();
    server = await start(db.url);
    const now = Date.now();
    await ensurePartitions(db.pool, [utcDay(now), utcDay(now - 86_400_000)]);
    const res = await server.call("POST", "/api/v1/alerts", {
      name: "new groups",
      metric: "new_error_group",
      webhookUrl: receiver.url,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as AlertRuleCreateResponse;
    ruleId = created.rule.id;
    expect(created.rule).toMatchObject({
      metric: "new_error_group",
      service: null,
      route: null,
      threshold: 0,
    });
    // Rules are created "now": groups first seen earlier never notify it.
    await sleep(50);
  });

  afterAll(async () => {
    await server?.close();
    await receiver?.close();
    await db?.drop();
  });

  it("stores a group, notifies once when it is new, resolves it, and regresses it in a newer release", async () => {
    await fail("db timeout", "1.0.0");
    await settle();
    let g = find(await groups(), "db timeout");
    expect(g?.triage).toEqual({ state: "open" });
    expect(payloads().map((p) => p.errorGroup?.reason)).toEqual(["new"]);
    expect(payloads()[0]).toMatchObject({
      state: "firing",
      service: "shop",
      route: "/orders",
      rule: { id: ruleId, metric: "new_error_group" },
      errorGroup: { pattern: "db timeout", release: "1.0.0", service: "shop" },
    });
    // Nothing new: nothing more is sent, however often it is evaluated.
    await settle();
    await settle();
    expect(receiver.requests).toHaveLength(1);

    const key = (g as ErrorGroup).key;
    const resolved = await act("resolve", key);
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as ErrorGroupTriageResponse;
    expect(body).toMatchObject({
      updated: 1,
      triage: { state: "resolved", resolvedInRelease: "1.0.0" },
    });
    g = find(await groups(), "db timeout");
    expect(g?.triage?.state).toBe("resolved");
    // Still occurring, but in the release it was resolved in: it stays resolved.
    await sleep(30);
    await fail("db timeout", "1.0.0");
    await settle();
    expect(find(await groups(), "db timeout")?.triage?.state).toBe("resolved");
    expect(receiver.requests).toHaveLength(1);

    // The same error from a newer version: regressed, and one notification.
    await sleep(30);
    await fail("db timeout", "1.1.0");
    await settle();
    g = find(await groups(), "db timeout");
    expect(g?.triage).toMatchObject({
      state: "regressed",
      resolvedInRelease: "1.0.0",
    });
    expect(g?.triage?.regressedAtUnixMs).toBeGreaterThan(
      g?.triage?.resolvedAtUnixMs ?? Infinity,
    );
    expect(payloads().map((p) => p.errorGroup?.reason)).toEqual([
      "new",
      "regressed",
    ]);
    expect(payloads()[1]?.errorGroup).toMatchObject({
      resolvedInRelease: "1.0.0",
      release: "1.1.0",
    });
    // Once: more evaluations, more occurrences, and a second evaluator (a restart, or a replica
    // that runs after this one) send nothing more.
    await settle();
    await fail("db timeout", "1.1.0");
    await settle();
    const other = new AlertEvaluator(
      db.pool,
      new WebhookSender({ allowedHosts: ["127.0.0.1"], backoffMs: () => 10 }),
      { retentionDays: 7 },
    );
    await other.runOnce();
    expect(receiver.requests).toHaveLength(2);
    // The events were recorded as ordinary firing notifications.
    const events = await db.pool.query(
      "SELECT kind, delivery FROM alert_events WHERE rule_id = $1 ORDER BY id",
      [ruleId],
    );
    expect(events.rows).toEqual([
      { kind: "firing", delivery: "sent" },
      { kind: "firing", delivery: "sent" },
    ]);
    const counts = await db.pool.query<{
      occurrences: string;
      regressions: number;
    }>(
      "SELECT occurrences, regressions FROM error_groups WHERE pattern = 'db timeout'",
    );
    expect(counts.rows[0]).toEqual({ occurrences: "4", regressions: 1 });
    const releases = await db.pool.query<{
      release: string;
      occurrences: string;
    }>(
      "SELECT release, occurrences FROM error_group_releases ORDER BY release",
    );
    expect(releases.rows).toEqual([
      { release: "1.0.0", occurrences: "2" },
      { release: "1.1.0", occurrences: "2" },
    ]);
  });

  it("a group resolved while its release is unknown regresses on any later occurrence", async () => {
    await fail("no release error", "", "/norelease");
    await db.pool.query("UPDATE traces SET release = NULL");
    await server.sync.runOnce();
    const g = find(await groups(), "no release error");
    expect(g).toBeDefined();
    await act("resolve", (g as ErrorGroup).key, "shop");
    await sleep(30);
    await fail("no release error", "9.9.9", "/norelease");
    await server.sync.runOnce();
    expect(find(await groups(), "no release error")?.triage?.state).toBe(
      "regressed",
    );
    // Resolved before the evaluator saw it, so it never notified as new: only the regression.
    await settle();
    expect(
      payloads()
        .filter((p) => p.errorGroup?.pattern === "no release error")
        .map((p) => p.errorGroup?.reason),
    ).toEqual(["regressed"]);
  });

  it("an ignored group is out of the list, the counts and the alerts until it is reopened", async () => {
    await fail("noisy", "1.1.0", "/noisy");
    await server.sync.runOnce();
    const g = find(await groups(), "noisy") as ErrorGroup;
    const before = (await groups()).groups.length;
    const ignored = await act("ignore", g.key);
    expect(ignored.status).toBe(200);
    expect(
      ((await ignored.json()) as ErrorGroupTriageResponse).triage.state,
    ).toBe("ignored");
    // Evaluated while ignored: no notification for it.
    const sent = receiver.requests.length;
    await settle();
    expect(receiver.requests).toHaveLength(sent);
    const list = await groups();
    expect(find(list, "noisy")).toBeUndefined();
    expect(list.groups).toHaveLength(before - 1);
    expect(list.ignoredCount).toBe(1);
    // The filters show it.
    for (const q of ["&triage=ignored", "&triage=all"]) {
      expect(find(await groups(q), "noisy")?.triage?.state).toBe("ignored");
    }
    expect(find(await groups("&triage=open"), "noisy")).toBeUndefined();
    // Occurrences go on being stored, and do not reopen it.
    await sleep(30);
    await fail("noisy", "2.0.0", "/noisy");
    await settle();
    expect(receiver.requests).toHaveLength(sent);
    expect(find(await groups("&triage=ignored"), "noisy")?.triage?.state).toBe(
      "ignored",
    );
    // Overview counts leave it out as well.
    const overview = await server.json<{ errors?: unknown }>(
      "/api/v1/overview?windowMinutes=15",
    );
    expect(JSON.stringify(overview)).not.toContain("noisy");

    const reopened = await act("reopen", g.key);
    expect(
      ((await reopened.json()) as ErrorGroupTriageResponse).triage.state,
    ).toBe("open");
    expect(find(await groups(), "noisy")?.triage?.state).toBe("open");
    expect((await groups()).ignoredCount).toBe(0);
    // Un-ignored, it is a live group again: it notifies as a new one.
    await settle();
    expect(receiver.requests).toHaveLength(sent + 1);
    expect(payloads().at(-1)?.errorGroup).toMatchObject({
      reason: "new",
      pattern: "noisy",
    });
  });

  it("a rule's service and route filters apply", async () => {
    const other = await server.call("POST", "/api/v1/alerts", {
      name: "billing only",
      metric: "new_error_group",
      service: "billing",
      webhookUrl: receiver.url,
    });
    expect(other.status).toBe(201);
    await sleep(50);
    const sent = receiver.requests.length;
    server.evalErrors.length = 0;
    await fail("shop only error", "1.1.0", "/shop-only");
    await fail("billing error", "3.0.0", "/invoices", "billing");
    await settle();
    // An intermittent failure (about 1 in 10 full runs, second rule without a webhook): say
    // what the evaluator reported and what the tables held.
    const dump = async (): Promise<string> => {
      const q = async (sql: string) =>
        JSON.stringify((await db.pool.query(sql)).rows);
      return [
        `evaluator reported: ${JSON.stringify(server.evalErrors)}`,
        `alert_rules: ${await q("SELECT id, name, metric, service_name, route, enabled, created_at FROM alert_rules ORDER BY id")}`,
        `error_groups: ${await q("SELECT service_name, environment, route, pattern, created_at FROM error_groups ORDER BY created_at")}`,
        `error_group_alerts: ${await q("SELECT * FROM error_group_alerts ORDER BY 1, 2")}`,
        `webhooks since: ${JSON.stringify(
          payloads()
            .slice(sent)
            .map((p) => [p.rule.name, p.errorGroup?.pattern]),
        )}`,
      ].join("\n");
    };
    try {
      expect(server.evalErrors, "evaluation errors").toEqual([]);
      // Rule 1 (every service) gets both, the billing rule only the billing one.
      const got = payloads().slice(sent);
      const ofRule = (id: string) =>
        got.filter((p) => p.rule.id === id).map((p) => p.errorGroup?.pattern);
      expect(ofRule(ruleId).sort()).toEqual([
        "billing error",
        "shop only error",
      ]);
      const billingRule = got.find((p) => p.rule.name === "billing only");
      expect(billingRule?.errorGroup?.pattern).toBe("billing error");
      expect(got.filter((p) => p.rule.name === "billing only")).toHaveLength(1);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${await dump()}`, {
        cause: error,
      });
    }
  });

  it("keeps groups, their triage and new_error_group alerts apart per environment (D-101)", async () => {
    const prodRule = await server.call("POST", "/api/v1/alerts", {
      name: "production groups",
      metric: "new_error_group",
      environment: "production",
      webhookUrl: receiver.url,
    });
    expect(prodRule.status).toBe(201);
    const prodRuleId = ((await prodRule.json()) as AlertRuleCreateResponse).rule
      .id;
    await sleep(50);
    const sent = receiver.requests.length;
    // One error, the same service, two environments. Its own service: a service seen with an
    // environment changes how an env-less triage call creates rows (checked below).
    await fail("env split", "1.0.0", "/env", "envshop", "staging");
    await fail("env split", "1.0.0", "/env", "envshop", "production");
    await settle();

    const stored = await db.pool.query<{ environment: string }>(
      "SELECT environment FROM error_groups WHERE pattern = 'env split' ORDER BY environment",
    );
    expect(stored.rows.map((r) => r.environment)).toEqual([
      "production",
      "staging",
    ]);
    // The rule over every environment notifies each environment's group once; the production
    // rule only production's.
    const got = payloads()
      .slice(sent)
      .filter((p) => p.errorGroup?.pattern === "env split");
    const envsOf = (id: string) =>
      got
        .filter((p) => p.rule.id === id)
        .map((p) => [p.environment, p.errorGroup?.environment])
        .sort();
    expect(envsOf(ruleId)).toEqual([
      ["production", "production"],
      ["staging", "staging"],
    ]);
    expect(envsOf(prodRuleId)).toEqual([["production", "production"]]);

    // Lists are scoped like every query, and the group is one group over both.
    const inEnv = (environment: string) =>
      groups(`&environment=${environment}`).then((r) => find(r, "env split"));
    const key = (await inEnv("staging"))?.key as string;
    expect(key).toBeDefined();
    expect((await inEnv("production"))?.key).toBe(key);
    expect(await inEnv("unset")).toBeUndefined();
    expect(await inEnv("other")).toBeUndefined();

    // Resolving in staging leaves production open; the unscoped list shows the most urgent.
    const resolved = await act("resolve", key, "envshop", "staging");
    expect(resolved.status).toBe(200);
    expect((await resolved.json()) as ErrorGroupTriageResponse).toMatchObject({
      updated: 1,
      triage: { state: "resolved" },
    });
    expect((await inEnv("staging"))?.triage?.state).toBe("resolved");
    expect((await inEnv("production"))?.triage?.state).toBe("open");
    expect(find(await groups(), "env split")?.triage?.state).toBe("open");
    // Ignoring production's copy too: the unscoped list now shows staging's resolved state.
    expect((await act("ignore", key, "envshop", "production")).status).toBe(
      200,
    );
    expect(find(await groups(), "env split")?.triage?.state).toBe("resolved");
    expect(await inEnv("production")).toBeUndefined();
    expect((await groups("&environment=production")).ignoredCount).toBe(1);

    // A newer release in staging regresses staging's copy only, and only the rule over every
    // environment hears of it.
    const before = receiver.requests.length;
    await sleep(30);
    await fail("env split", "1.1.0", "/env", "envshop", "staging");
    await fail("env split", "1.1.0", "/env", "envshop", "production");
    await settle();
    const states = await db.pool.query<{ environment: string; state: string }>(
      "SELECT environment, state FROM error_groups WHERE pattern = 'env split' ORDER BY environment",
    );
    expect(states.rows).toEqual([
      { environment: "production", state: "ignored" },
      { environment: "staging", state: "regressed" },
    ]);
    const later = payloads().slice(before);
    expect(
      later.map((p) => [p.rule.id, p.environment, p.errorGroup?.reason]),
    ).toEqual([[ruleId, "staging", "regressed"]]);

    // Triage of a group not stored yet: without an environment nothing can be created for a
    // service that has environments; naming one creates it there.
    const unseen = JSON.stringify(["Error", "not stored yet", "/env"]);
    expect((await act("ignore", unseen, "envshop")).status).toBe(404);
    expect((await act("ignore", unseen, "envshop", "staging")).status).toBe(
      200,
    );
    const created = await db.pool.query<{ environment: string }>(
      "SELECT environment FROM error_groups WHERE pattern = 'not stored yet'",
    );
    expect(created.rows).toEqual([{ environment: "staging" }]);
    // `unset` names the copy without an environment, stored as ''.
    expect((await act("ignore", unseen, "envshop", "unset")).status).toBe(200);
    const both = await db.pool.query<{ environment: string }>(
      "SELECT environment FROM error_groups WHERE pattern = 'not stored yet' ORDER BY environment",
    );
    expect(both.rows.map((r) => r.environment)).toEqual(["", "staging"]);
    expect(
      (
        await server.call("POST", "/api/v1/errors/groups/ignore", {
          key: unseen,
          environment: "",
        })
      ).status,
    ).toBe(400);
  });

  it("states survive a restart and the deletion of every span partition", async () => {
    const before = await db.pool.query<{ state: string; n: string }>(
      "SELECT state, count(*) AS n FROM error_groups GROUP BY state ORDER BY state",
    );
    expect(before.rows.length).toBeGreaterThan(1);
    await server.close();
    // Every day partition of spans and traces goes (what retention does, all at once).
    const parts = await db.pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname IN ('spans', 'traces')`,
    );
    expect(parts.rows.length).toBeGreaterThan(0);
    for (const { name } of parts.rows) {
      await db.pool.query(`DROP TABLE "${name}"`);
    }
    server = await start(db.url);
    const now = Date.now();
    await ensurePartitions(db.pool, [utcDay(now), utcDay(now - 86_400_000)]);
    const after = await db.pool.query<{ state: string; n: string }>(
      "SELECT state, count(*) AS n FROM error_groups GROUP BY state ORDER BY state",
    );
    expect(after.rows).toEqual(before.rows);
    expect((await groups()).groups).toEqual([]);
    // The stored state still drives behaviour: the regressed group, resolved again in 1.1.0,
    // regresses again in 1.2.0 though none of its old spans exist.
    const row = await db.pool.query<{ group_key: string }>(
      "SELECT group_key FROM error_groups WHERE pattern = 'db timeout'",
    );
    const resolved = await act(
      "resolve",
      row.rows[0]?.group_key as string,
      "shop",
    );
    expect(resolved.status).toBe(200);
    await sleep(30);
    await fail("db timeout", "1.2.0");
    await server.sync.runOnce();
    const state = await db.pool.query<{ state: string; regressions: number }>(
      "SELECT state, regressions FROM error_groups WHERE pattern = 'db timeout'",
    );
    expect(state.rows[0]).toEqual({ state: "regressed", regressions: 2 });
    // The second regression is a new episode: one more notification, once.
    const sent = receiver.requests.length;
    await settle();
    await settle();
    expect(receiver.requests).toHaveLength(sent + 1);
    expect(payloads().at(-1)?.errorGroup?.reason).toBe("regressed");
  });

  it("refuses writes without an admin session, from another origin, and malformed ones", async () => {
    const key = JSON.stringify(["Error", "x", null]);
    const url = `${server.baseUrl}/api/v1/errors/groups/resolve`;
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ key, service: "shop" }),
      });
    // No session.
    expect((await post({ origin: server.baseUrl })).status).toBe(401);
    // A session, another origin, or none.
    for (const headers of [
      { cookie: server.cookie, origin: "https://evil.example" },
      { cookie: server.cookie } as Record<string, string>,
    ]) {
      const res = await post(headers);
      expect(res.status).toBe(403);
    }
    expect(
      (await db.pool.query("SELECT 1 FROM error_groups WHERE pattern = 'x'"))
        .rowCount,
    ).toBe(0);
    for (const bad of [
      { key: "not json" },
      { key: JSON.stringify(["Error", "x"]) },
      { key: `${JSON.stringify(["Error", "x", null])} ` },
      { key, extra: 1 },
      { key, service: "" },
    ]) {
      expect(
        (await server.call("POST", "/api/v1/errors/groups/ignore", bad)).status,
      ).toBe(400);
    }
    // A group nobody has stored, and no service to create it under.
    expect((await act("resolve", key)).status).toBe(404);
    // No CORS headers on a refusal or an answer.
    const ok = await act("ignore", key, "shop");
    expect(ok.status).toBe(200);
    expect(
      [...ok.headers.keys()].filter((h) => h.startsWith("access-control-")),
    ).toEqual([]);
  });
});
