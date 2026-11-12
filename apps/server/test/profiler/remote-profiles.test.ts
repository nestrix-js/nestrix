/**
 * Remote CPU profiling on the whole server against a real PostgreSQL (docs/backlog/phase-10.md
 * P10-02): check-in upsert and order handoff; upload by the right key stores the profile and the
 * detail returns functions and flame; uploads and failure reports by another key or for another
 * state are refused; expiry; the start route's refusals (API token, cross-site, wrong origin,
 * unknown instance, duplicates, cool-down); the instances window; retention; a failing store.
 */
import "reflect-metadata";
import { createHash } from "node:crypto";
import type {
  CheckInResponse,
  InstanceListResponse,
  MetaResponse,
  RemoteProfileConflictError,
  RemoteProfileDetail,
  RemoteProfileListResponse,
  RemoteProfileSummary,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteProfileStore } from "../../src/profiler/store.js";
import { type AlertsServer, startAlertsServer } from "../alerts/helpers.js";
import { corsHeaders, rawRequest } from "../auth/helpers.js";
import { KEY, OTHER_KEY } from "../ingest/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import {
  checkIn,
  createReaderToken,
  type Instance,
  newInstance,
  reportFailed,
  sampleProfile,
  startCapture,
  upload,
} from "./helpers.js";

/** The ownership principal of an ingest key: the first 16 hex characters of its SHA-256. */
const fingerprint = (key: string) =>
  createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);

describe.skipIf(noDatabase)(`remote profiling ${skipReason}`, () => {
  let db: TestDb;
  let server: AlertsServer;
  let readerToken: string;

  const read = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${server.baseUrl}${path}`, {
      headers: { cookie: server.cookie, ...headers },
      redirect: "manual",
    });
  const readWithToken = (path: string) =>
    fetch(`${server.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${readerToken}` },
    });

  /** Checks in and returns the answer. */
  const checkInOk = async (
    instance: Instance,
    extra: Record<string, unknown> = {},
    key?: string,
  ): Promise<CheckInResponse> => {
    const res = await checkIn(server.baseUrl, { ...instance, ...extra }, key);
    expect(res.status).toBe(200);
    return (await res.json()) as CheckInResponse;
  };

  /** Starts a capture (202) and returns it. */
  const started = async (
    instance: Instance,
    durationSeconds = 5,
  ): Promise<RemoteProfileSummary> => {
    const res = await startCapture(server, { ...instance, durationSeconds });
    expect(res.status, res.body).toBe(202);
    return JSON.parse(res.body) as RemoteProfileSummary;
  };

  /** Checks in, starts a capture, checks in again: the capture is running. */
  const running = async (instance: Instance): Promise<string> => {
    await checkInOk(instance);
    const capture = await started(instance);
    const answer = await checkInOk(instance);
    expect(answer.capture?.id).toBe(capture.id);
    return capture.id;
  };

  const detail = async (id: string): Promise<RemoteProfileDetail> => {
    const res = await read(`/api/v1/remote-profiles/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as RemoteProfileDetail;
  };

  const countFor = async (instanceId: string): Promise<number> => {
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM remote_profiles WHERE instance_id = $1",
      [instanceId],
    );
    return rows[0].n as number;
  };

  beforeAll(async () => {
    db = await createTestDb("remote_profiles");
    server = await startAlertsServer(db.url);
    readerToken = await createReaderToken(server);
  });

  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  describe("check-in", () => {
    it("upserts the instance with its key and answers nextCheckInMs without an order", async () => {
      const instance = newInstance("checkin-svc");
      const first = await checkInOk(instance, {
        version: "1.0.0",
        host: "web-1",
        pid: 4242,
        runtime: "v26.1.0",
        sdkVersion: "0.1.0",
        unknownField: { ignored: true },
      });
      expect(first).toEqual({ nextCheckInMs: 15000 });
      await checkInOk(instance, { version: "1.0.1", host: "web-1" });
      const { rows } = await db.pool.query(
        "SELECT * FROM instances WHERE instance_id = $1",
        [instance.instanceId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        service: "checkin-svc",
        version: "1.0.1",
        host: "web-1",
        pid: null,
        principal: fingerprint(KEY),
      });
      expect(rows[0].last_seen.getTime()).toBeGreaterThanOrEqual(
        rows[0].first_seen.getTime(),
      );
    });

    it("cuts optional fields to 256 characters and drops control characters", async () => {
      const instance = newInstance("checkin-cut");
      await checkInOk(instance, {
        version: `v\u0000${"x".repeat(400)}`,
        pid: -1,
        host: 12,
      });
      const { rows } = await db.pool.query(
        "SELECT version, pid, host FROM instances WHERE instance_id = $1",
        [instance.instanceId],
      );
      expect(rows[0].version).toBe(`v${"x".repeat(255)}`);
      expect(rows[0].pid).toBeNull();
      expect(rows[0].host).toBeNull();
    });

    it("refuses a missing or oversized service or instance id, non-JSON and the wrong media type", async () => {
      const id = newInstance("x").instanceId;
      for (const body of [
        { instanceId: id },
        { service: "", instanceId: id },
        { service: "s".repeat(257), instanceId: id },
        { service: "ok", instanceId: 7 },
        { service: "bad\nname", instanceId: id },
        [],
      ]) {
        const res = await checkIn(server.baseUrl, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toMatchObject({
          error: { code: "bad_request" },
        });
      }
      expect((await checkIn(server.baseUrl, "{nope")).status).toBe(400);
      const text = await checkIn(server.baseUrl, "{}", undefined, {
        "content-type": "text/plain",
      });
      expect(text.status).toBe(415);
    });

    it("needs an ingest key, not a session or an API token", async () => {
      const body = newInstance("checkin-auth");
      const none = await fetch(`${server.baseUrl}/v1/nestrix/check-in`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: server.cookie },
        body: JSON.stringify(body),
      });
      expect(none.status).toBe(401);
      expect(none.headers.get("www-authenticate")).toContain("nestrix-ingest");
      expect(corsHeaders(none.headers)).toEqual([]);
      expect((await checkIn(server.baseUrl, body, readerToken)).status).toBe(
        401,
      );
      expect((await checkIn(server.baseUrl, body, "w".repeat(40))).status).toBe(
        401,
      );
    });

    it("refuses another key's check-in for an existing instance id", async () => {
      const instance = newInstance("checkin-owner");
      await checkInOk(instance);
      const other = await checkIn(server.baseUrl, instance, OTHER_KEY);
      expect(other.status).toBe(409);
      const { rows } = await db.pool.query(
        "SELECT principal FROM instances WHERE instance_id = $1",
        [instance.instanceId],
      );
      expect(rows[0].principal).toBe(fingerprint(KEY));
    });

    it("keeps an instance across a key rotation that moves its key to another index", async () => {
      // Keys `KEY,OTHER_KEY` become `OTHER_KEY,THIRD`: OTHER_KEY goes from index 1 to 0.
      const THIRD = "q".repeat(40);
      const instance = newInstance("checkin-rotation");
      await checkInOk(instance, {}, OTHER_KEY);
      const rotated = await startAlertsServer(db.url, {
        NESTRIX_INGEST_KEYS: `${OTHER_KEY},${THIRD}`,
      });
      try {
        const capture = await started(instance);
        const answer = await checkIn(rotated.baseUrl, instance, OTHER_KEY);
        expect(answer.status).toBe(200);
        expect(((await answer.json()) as CheckInResponse).capture?.id).toBe(
          capture.id,
        );
        expect(
          (
            await upload(
              rotated.baseUrl,
              capture.id,
              sampleProfile(),
              OTHER_KEY,
            )
          ).status,
        ).toBe(204);
        // The key that took index 1 is not the owner.
        expect((await checkIn(rotated.baseUrl, instance, THIRD)).status).toBe(
          409,
        );
      } finally {
        await rotated.close();
      }
    });

    it("an instance registered before fingerprints (principal key:<n>) is not locked out", async () => {
      const instance = newInstance("checkin-legacy");
      await db.pool.query(
        "INSERT INTO instances (service, instance_id, principal) VALUES ($1, $2, 'key:5')",
        [instance.service, instance.instanceId],
      );
      await checkInOk(instance);
      const capture = await started(instance);
      // A capture handed out under the old principal: the first check-in carries it over too.
      await db.pool.query(
        "UPDATE remote_profiles SET state = 'running', started_at = now(), principal = 'key:5' WHERE id = $1",
        [capture.id],
      );
      await checkInOk(instance, { runningCaptureId: capture.id });
      const { rows } = await db.pool.query(
        "SELECT principal FROM instances WHERE instance_id = $1",
        [instance.instanceId],
      );
      expect(rows[0].principal).toBe(fingerprint(KEY));
      expect(
        (await upload(server.baseUrl, capture.id, sampleProfile())).status,
      ).toBe(204);
    });
  });

  describe("a lost order", () => {
    const age = (id: string, seconds: number) =>
      db.pool.query(
        "UPDATE remote_profiles SET started_at = now() - make_interval(secs => $2) WHERE id = $1",
        [id, seconds],
      );

    it("fails a capture running over 20 s that the instance does not report, then hands out the next", async () => {
      const instance = newInstance("lost-order");
      const id = await running(instance);
      await age(id, 25);
      await checkInOk(instance);
      const lost = await detail(id);
      expect(lost.state).toBe("failed");
      expect(lost.error).toBe("the instance did not receive the order");
      // The cool-down of a failed capture still applies to a new start; lift it, as time would.
      await db.pool.query(
        "UPDATE remote_profiles SET finished_at = now() - interval '11 seconds' WHERE id = $1",
        [id],
      );
      const next = await started(instance);
      expect((await checkInOk(instance)).capture?.id).toBe(next.id);
    });

    it("fails it also when the instance reports a different capture", async () => {
      const instance = newInstance("lost-order-other");
      const id = await running(instance);
      await age(id, 25);
      await checkInOk(instance, { runningCaptureId: "0123456789abcdef" });
      expect((await detail(id)).state).toBe("failed");
    });

    it("keeps one the instance reports, and one younger than 20 s", async () => {
      const reported = await running(newInstance("lost-order-kept"));
      const instance = newInstance("lost-order-kept");
      const young = await running(instance);
      await age(young, 15);
      await checkInOk(instance);
      expect((await detail(young)).state).toBe("running");
      await age(young, 25);
      await checkInOk(instance, { runningCaptureId: young });
      expect((await detail(young)).state).toBe("running");
      expect((await detail(reported)).state).toBe("running");
    });
  });

  describe("instances", () => {
    it("lists instances seen in the last 2 minutes, filtered by service, for a session and a token", async () => {
      const a = newInstance("window-a");
      const b = newInstance("window-b");
      const stale = newInstance("window-a");
      await checkInOk(a, { version: "2.0.0" });
      await checkInOk(b);
      await checkInOk(stale);
      await db.pool.query(
        "UPDATE instances SET last_seen = now() - interval '121 seconds' WHERE instance_id = $1",
        [stale.instanceId],
      );
      const res = await read("/api/v1/instances?service=window-a");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const list = (await res.json()) as InstanceListResponse;
      expect(list.instances.map((i) => i.instanceId)).toEqual([a.instanceId]);
      expect(list.instances[0]).toMatchObject({
        service: "window-a",
        version: "2.0.0",
        capture: null,
      });

      const byToken = await readWithToken("/api/v1/instances");
      expect(byToken.status).toBe(200);
      const all = (await byToken.json()) as InstanceListResponse;
      const ids = all.instances.map((i) => i.instanceId);
      expect(ids).toContain(a.instanceId);
      expect(ids).toContain(b.instanceId);
      expect(ids).not.toContain(stale.instanceId);
    });

    it("refuses unknown query parameters", async () => {
      expect((await read("/api/v1/instances?x=1")).status).toBe(400);
    });

    it("meta reports the remote profiler", async () => {
      const meta = (await (await read("/api/v1/meta")).json()) as MetaResponse;
      expect(meta.profiler).toEqual({
        available: false,
        running: false,
        remote: true,
      });
    });
  });

  describe("starting a capture", () => {
    it("creates a pending capture that the next check-in hands over as running", async () => {
      const instance = newInstance("start-ok");
      await checkInOk(instance, { version: "3.1.4" });
      const capture = await started(instance, 30);
      expect(capture).toMatchObject({
        service: "start-ok",
        instanceId: instance.instanceId,
        version: "3.1.4",
        state: "pending",
        durationMs: 30_000,
        startedAtUnixMs: null,
      });
      expect(capture.id).toMatch(/^[0-9a-f]{16}$/);

      const listed = (await (
        await read("/api/v1/instances?service=start-ok")
      ).json()) as InstanceListResponse;
      expect(listed.instances[0]?.capture?.state).toBe("pending");

      const answer = await checkInOk(instance);
      expect(answer).toEqual({
        nextCheckInMs: 15000,
        capture: { id: capture.id, durationMs: 30_000 },
      });
      const after = await detail(capture.id);
      expect(after.state).toBe("running");
      expect(after.startedAtUnixMs).not.toBeNull();
      // Handed over once only.
      expect((await checkInOk(instance)).capture).toBeUndefined();
    });

    it("defaults to 30 s", async () => {
      const instance = newInstance("start-default");
      await checkInOk(instance);
      const res = await startCapture(server, instance);
      expect(res.status).toBe(202);
      expect(JSON.parse(res.body).durationMs).toBe(30_000);
    });

    it("answers 409 with the active capture while one is pending or running", async () => {
      const instance = newInstance("start-dup");
      await checkInOk(instance);
      const first = await started(instance);
      const dup = await startCapture(server, instance);
      expect(dup.status).toBe(409);
      const body = JSON.parse(dup.body) as RemoteProfileConflictError;
      expect(body.error.code).toBe("conflict");
      expect(body.capture.id).toBe(first.id);
      await checkInOk(instance);
      const whileRunning = await startCapture(server, instance);
      expect(whileRunning.status).toBe(409);
    });

    it("lets only one of several concurrent starts through", async () => {
      const instance = newInstance("start-race");
      await checkInOk(instance);
      const answers = await Promise.all(
        Array.from({ length: 6 }, () => startCapture(server, instance)),
      );
      const statuses = answers.map((a) => a.status).sort();
      expect(statuses).toEqual([202, 409, 409, 409, 409, 409]);
    });

    it("answers 404 for an unknown instance and one not seen for 2 minutes", async () => {
      const unknown = await startCapture(server, newInstance("start-unknown"));
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body).error.code).toBe("not_found");
      const stale = newInstance("start-stale");
      await checkInOk(stale);
      await db.pool.query(
        "UPDATE instances SET last_seen = now() - interval '121 seconds' WHERE instance_id = $1",
        [stale.instanceId],
      );
      expect((await startCapture(server, stale)).status).toBe(404);
    });

    it("refuses an API token, even with every browser header and a session cookie", async () => {
      const instance = newInstance("start-token");
      await checkInOk(instance);
      const res = await startCapture(server, instance, {
        cookie: null,
        authorization: `Bearer ${readerToken}`,
      });
      expect(res.status).toBe(401);
      const both = await startCapture(server, instance, {
        authorization: `Bearer ${readerToken}`,
      });
      expect(both.status).toBe(401);
      expect(await countFor(instance.instanceId)).toBe(0);
    });

    it("refuses cross-site, same-site, missing Sec-Fetch-Site, a wrong or missing Origin", async () => {
      const instance = newInstance("start-csrf");
      await checkInOk(instance);
      const cases: Array<[Record<string, string | null>, number]> = [
        [{ "sec-fetch-site": "cross-site" }, 403],
        [{ "sec-fetch-site": "same-site" }, 403],
        [{ "sec-fetch-site": "none" }, 403],
        [{ "sec-fetch-site": null }, 403],
        [{ origin: "http://localhost:3000" }, 403],
        [{ origin: "null" }, 403],
        // The admin middleware lets a missing Origin pass with Sec-Fetch-Site: same-origin (for its
        // login form); the start route does not.
        [{ origin: null }, 403],
        [{ cookie: null }, 401],
      ];
      for (const [headers, status] of cases) {
        const res = await startCapture(server, instance, headers);
        expect(res.status, JSON.stringify(headers)).toBe(status);
        expect(corsHeaders(res.headers)).toEqual([]);
      }
      // Two Sec-Fetch-Site lines.
      const body = JSON.stringify(instance);
      const twice = await rawRequest(
        server.baseUrl,
        "POST",
        "/api/v1/remote-profiles",
        [
          // With array headers Node's client sends no Host of its own (and its server needs one).
          "host",
          new URL(server.baseUrl).host,
          "cookie",
          server.cookie,
          "origin",
          server.origin,
          "sec-fetch-site",
          "same-origin",
          "sec-fetch-site",
          "same-origin",
          "content-type",
          "application/json",
          // No Content-Length: with array headers Node's client adds its own framing.
        ],
        body,
      );
      expect(twice.status, twice.body).toBe(403);
      expect(JSON.parse(twice.body).error.message).toMatch(/Sec-Fetch-Site/);
      // The start route's own Origin rule, past the middleware.
      const noOrigin = await startCapture(server, instance, { origin: null });
      expect(JSON.parse(noOrigin.body).error.message).toMatch(
        /Origin header equal to this server's own origin/,
      );
      expect(await countFor(instance.instanceId)).toBe(0);
    });

    it("refuses the wrong media type, an oversized body, query parameters and bad fields", async () => {
      const instance = newInstance("start-body");
      await checkInOk(instance);
      expect(
        (await startCapture(server, instance, { "content-type": "text/plain" }))
          .status,
      ).toBe(415);
      const big = JSON.stringify({ ...instance, pad: "x".repeat(2000) });
      expect((await startCapture(server, big)).status).toBe(413);
      expect(
        (
          await startCapture(
            server,
            instance,
            {},
            "/api/v1/remote-profiles?durationSeconds=5",
          )
        ).status,
      ).toBe(400);
      for (const body of [
        { ...instance, extra: 1 },
        { ...instance, durationSeconds: 0 },
        { ...instance, durationSeconds: 121 },
        { ...instance, durationSeconds: 1.5 },
        { service: instance.service },
        [instance],
      ]) {
        const res = await startCapture(server, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(JSON.parse(res.body).error.code).toBe("bad_request");
      }
      expect(await countFor(instance.instanceId)).toBe(0);
    });
  });

  describe("upload", () => {
    it("stores the right instance's upload; the detail has functions and flame; download returns it", async () => {
      const instance = newInstance("upload-ok");
      const id = await running(instance);
      const res = await upload(server.baseUrl, id, sampleProfile());
      expect(res.status, await res.clone().text()).toBe(204);

      const d = await detail(id);
      expect(d).toMatchObject({
        id,
        state: "done",
        samples: 7,
        actualDurationMs: 30_000,
        error: null,
      });
      expect(d.bytes).toBeGreaterThan(100);
      expect(d.finishedAtUnixMs).not.toBeNull();
      expect(d.topFunctions?.[0]).toMatchObject({
        functionName: "work",
        url: "file:///app/work.js",
        line: 10,
        column: 3,
        selfSamples: 4,
        totalSamples: 4,
      });
      expect(d.topFunctions?.map((f) => f.functionName)).not.toContain(
        "(idle)",
      );
      // Flame: (root) without idle = 6 samples; main (5) -> work (4).
      expect(d.flame?.functionName).toBe("(root)");
      expect(d.flame?.totalSamples).toBe(6);
      const main = d.flame?.children.find((c) => c.functionName === "main");
      expect(main?.totalSamples).toBe(5);
      expect(main?.children[0]?.functionName).toBe("work");

      const file = await read(`/api/v1/remote-profiles/${id}/download`);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toContain("application/json");
      expect(file.headers.get("content-disposition")).toMatch(
        new RegExp(
          `^attachment; filename="nestrix-upload-ok-[0-9TZ-]+-${id}\\.cpuprofile"$`,
        ),
      );
      const text = await file.text();
      expect(text.length).toBe(d.bytes);
      const parsed = JSON.parse(text);
      expect(parsed.samples).toEqual([5, 5, 4, 5, 2, 3, 5]);
      expect(parsed.nodes[4].callFrame.scriptId).toBe("7");
      expect(parsed.nodes[4].callFrame.url).toBe("file:///app/work.js");

      // The token reads the detail and the download too.
      expect(
        (await readWithToken(`/api/v1/remote-profiles/${id}`)).status,
      ).toBe(200);
      expect(
        (await readWithToken(`/api/v1/remote-profiles/${id}/download`)).status,
      ).toBe(200);

      // A second upload of a finished capture.
      const again = await upload(server.baseUrl, id, sampleProfile());
      expect(again.status).toBe(409);

      const list = (await (
        await read(
          `/api/v1/remote-profiles?service=upload-ok&instanceId=${instance.instanceId}`,
        )
      ).json()) as RemoteProfileListResponse;
      expect(list.profiles.map((p) => p.id)).toEqual([id]);
      expect(list.profiles[0]).not.toHaveProperty("topFunctions");
    });

    it("accepts an upload without gzip and drops unknown fields", async () => {
      const id = await running(newInstance("upload-plain"));
      const profile = { ...sampleProfile(), extraneous: "dropped-marker" };
      const res = await upload(server.baseUrl, id, profile, undefined, {
        gzip: false,
      });
      expect(res.status).toBe(204);
      const text = await (
        await read(`/api/v1/remote-profiles/${id}/download`)
      ).text();
      expect(text).not.toContain("dropped-marker");
    });

    it("refuses an upload with another ingest key, for a pending, unknown or malformed id", async () => {
      const instance = newInstance("upload-owner");
      const id = await running(instance);
      const other = await upload(
        server.baseUrl,
        id,
        sampleProfile(),
        OTHER_KEY,
      );
      expect(other.status).toBe(404);
      const pendingInstance = newInstance("upload-pending");
      await checkInOk(pendingInstance);
      const pending = await started(pendingInstance);
      expect(
        (await upload(server.baseUrl, pending.id, sampleProfile())).status,
      ).toBe(404);
      expect(
        (await upload(server.baseUrl, "0123456789abcdef", sampleProfile()))
          .status,
      ).toBe(404);
      expect(
        (await upload(server.baseUrl, "NOT-AN-ID", sampleProfile())).status,
      ).toBe(404);
      expect((await detail(id)).state).toBe("running");
      // The rightful owner still can.
      expect((await upload(server.baseUrl, id, sampleProfile())).status).toBe(
        204,
      );
    });

    it("refuses a body that is not a CPU profile, without changing the capture", async () => {
      const id = await running(newInstance("upload-bad"));
      const bad: unknown[] = [
        "{not json",
        { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1 },
        { ...sampleProfile(), samples: [99], timeDeltas: [1] },
        { ...sampleProfile(), timeDeltas: [1] },
        { ...sampleProfile(), endTime: 0 },
        { ...sampleProfile(), nodes: [{ id: 1 }] },
        { ...sampleProfile(), nodes: [{ id: "1", callFrame: {} }] },
        [1, 2, 3],
      ];
      for (const body of bad) {
        const res = await upload(server.baseUrl, id, body);
        expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      }
      const notGzip = await upload(server.baseUrl, id, "plain", undefined, {
        gzip: false,
        headers: { "content-encoding": "gzip" },
      });
      expect(notGzip.status).toBe(400);
      const wrongType = await upload(
        server.baseUrl,
        id,
        sampleProfile(),
        undefined,
        { headers: { "content-type": "application/x-protobuf" } },
      );
      expect(wrongType.status).toBe(415);
      expect((await detail(id)).state).toBe("running");
    });

    it("refuses an upload declared over the 20 MiB limit before reading it", async () => {
      const id = await running(newInstance("upload-big"));
      const res = await rawRequest(
        server.baseUrl,
        "POST",
        `/v1/nestrix/profiles/${id}`,
        {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
          "content-length": String(21 * 1024 * 1024),
        },
        "{}",
      ).catch((error: Error) => ({ status: -1, body: error.message }));
      // Either the 413 arrives or the server closed the connection right after it.
      expect([413, -1]).toContain(res.status);
      expect((await detail(id)).state).toBe("running");
    });
  });

  describe("failure reports", () => {
    it("marks a running capture failed with the message cut to 500 characters", async () => {
      const id = await running(newInstance("failed-ok"));
      const res = await reportFailed(server.baseUrl, id, {
        message: `busy ${"y".repeat(800)}`,
        extra: true,
      });
      expect(res.status).toBe(204);
      const d = await detail(id);
      expect(d.state).toBe("failed");
      expect(d.error).toHaveLength(500);
      expect(d.topFunctions).toBeUndefined();
      expect(
        (await read(`/api/v1/remote-profiles/${id}/download`)).status,
      ).toBe(404);
      // Not running any more.
      expect(
        (await reportFailed(server.baseUrl, id, { message: "again" })).status,
      ).toBe(409);
      expect((await upload(server.baseUrl, id, sampleProfile())).status).toBe(
        409,
      );
    });

    it("refuses another key and a bad body", async () => {
      const id = await running(newInstance("failed-owner"));
      expect(
        (await reportFailed(server.baseUrl, id, { message: "x" }, OTHER_KEY))
          .status,
      ).toBe(404);
      expect(
        (await reportFailed(server.baseUrl, id, { message: 5 })).status,
      ).toBe(400);
      expect((await detail(id)).state).toBe("running");
    });
  });

  describe("cool-down", () => {
    it("answers 429 with Retry-After within 10 s of the instance's previous capture finishing", async () => {
      const instance = newInstance("cooldown");
      const id = await running(instance);
      expect((await upload(server.baseUrl, id, sampleProfile())).status).toBe(
        204,
      );
      const res = await startCapture(server, instance);
      expect(res.status).toBe(429);
      const retry = Number(res.headers["retry-after"]);
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(10);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("too_many_requests");
      expect(body.retryAfterSeconds).toBe(retry);
      // Another instance is not held back.
      const other = newInstance("cooldown");
      await checkInOk(other);
      expect((await startCapture(server, other)).status).toBe(202);
      // Once 10 s have passed.
      await db.pool.query(
        "UPDATE remote_profiles SET finished_at = now() - interval '11 seconds' WHERE id = $1",
        [id],
      );
      expect((await startCapture(server, instance)).status).toBe(202);
    });
  });

  describe("expiry", () => {
    it("expires a capture not picked up within 60 s; the instance never receives it", async () => {
      const instance = newInstance("expiry-pending");
      await checkInOk(instance);
      const capture = await started(instance);
      await db.pool.query(
        "UPDATE remote_profiles SET requested_at = now() - interval '61 seconds' WHERE id = $1",
        [capture.id],
      );
      expect((await checkInOk(instance)).capture).toBeUndefined();
      const d = await detail(capture.id);
      expect(d.state).toBe("expired");
      expect(d.error).toMatch(/did not check in/);
      // A new one may start at once (an expired capture brings no cool-down).
      expect((await startCapture(server, instance)).status).toBe(202);
    });

    it("expires a running capture without an upload after its duration plus 60 s; a late upload is refused", async () => {
      const id = await running(newInstance("expiry-running"));
      await db.pool.query(
        "UPDATE remote_profiles SET started_at = now() - interval '66 seconds' WHERE id = $1",
        [id],
      );
      expect((await upload(server.baseUrl, id, sampleProfile())).status).toBe(
        409,
      );
      const d = await detail(id);
      expect(d.state).toBe("expired");
      expect(d.error).toMatch(/did not upload/);
    });

    it("the sweep expires captures without any request", async () => {
      const instance = newInstance("expiry-sweep");
      await checkInOk(instance);
      const capture = await started(instance);
      await db.pool.query(
        "UPDATE remote_profiles SET requested_at = now() - interval '61 seconds' WHERE id = $1",
        [capture.id],
      );
      await server.app.get(RemoteProfileStore).sweep();
      const { rows } = await db.pool.query(
        "SELECT state FROM remote_profiles WHERE id = $1",
        [capture.id],
      );
      expect(rows[0].state).toBe("expired");
    });
  });

  describe("retention", () => {
    it("keeps the newest 20 finished per service, drops rows older than the span retention and old instances", async () => {
      const insert = (id: string, service: string, age: string) =>
        db.pool.query(
          `INSERT INTO remote_profiles (id, service, instance_id, state, requested_at, finished_at, duration_ms, requested_by)
           VALUES ($1, $2, 'i', 'failed', now() - $3::interval, now() - $3::interval, 1000, 'admin')`,
          [id, service, age],
        );
      for (let i = 0; i < 25; i++) {
        await insert(
          `aa${i.toString(16).padStart(14, "0")}`,
          "retention-many",
          `${i} minutes`,
        );
      }
      await insert("bb00000000000001", "retention-old", "30 days");
      await insert("bb00000000000002", "retention-old", "1 hour");
      await db.pool.query(
        "INSERT INTO instances (service, instance_id, principal, last_seen) VALUES ('retention-inst', 'gone', 'key:0', now() - interval '25 hours')",
      );
      await server.app.get(RemoteProfileStore).sweep();
      const many = await db.pool.query(
        "SELECT id FROM remote_profiles WHERE service = 'retention-many' ORDER BY requested_at DESC",
      );
      expect(many.rows).toHaveLength(20);
      expect(many.rows[0].id).toBe("aa00000000000000");
      const old = await db.pool.query(
        "SELECT id FROM remote_profiles WHERE service = 'retention-old'",
      );
      expect(old.rows.map((r) => r.id)).toEqual(["bb00000000000002"]);
      const gone = await db.pool.query(
        "SELECT count(*)::int AS n FROM instances WHERE service = 'retention-inst'",
      );
      expect(gone.rows[0].n).toBe(0);
    });
  });

  describe("faults", () => {
    it("a failing store answers 500 on both sides without the cause, and the server keeps serving", async () => {
      const store = server.app.get(RemoteProfileStore);
      const original = store.checkIn.bind(store);
      const originalList = store.list.bind(store);
      store.checkIn = async () => {
        throw new Error("database down");
      };
      store.list = async () => {
        throw new Error("database down");
      };
      try {
        const res = await checkIn(server.baseUrl, newInstance("faults"));
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({
          error: { code: "internal", message: "internal error" },
        });
        const listed = await read("/api/v1/remote-profiles");
        expect(listed.status).toBe(500);
        expect(await listed.text()).not.toContain("database down");
      } finally {
        store.checkIn = original;
        store.list = originalList;
      }
      await checkInOk(newInstance("faults"));
    });
  });

  it("unknown capture ids answer 404 on the dashboard routes", async () => {
    for (const path of [
      "/api/v1/remote-profiles/0123456789abcdef",
      "/api/v1/remote-profiles/zz",
      "/api/v1/remote-profiles/0123456789abcdef/download",
    ]) {
      const res = await read(path);
      expect(res.status, path).toBe(404);
    }
  });
});
