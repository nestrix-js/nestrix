// Issue #20 acceptance: BullMQ's spans in an ESM app run with plain `node`, started the way a real
// app starts (Nestrix registers its provider while Nest builds the module graph, after the module
// files, and so `telemetry: ...` in `BullModule.forRoot()`, were evaluated). jobs.test.ts cannot
// show this: it registers a provider before its module is evaluated. The app is examples/bullmq-esm, built by `pnpm build`: an API on platform-node
// (dist/main.js) and a separate worker process (dist/worker.js, createApplicationContext), both
// with NestrixInstrument, exporting OTLP/HTTP JSON to a receiver in this test. Real Redis 8 from
// test/integrations/containers.global.ts.
//
// Three runs, in parallel, each with its own queue and receiver:
// - "nestrix": the documented setup, `telemetry: bullmqTelemetry(...)` written inline in
//   `BullModule.forRoot()`. Full trace shape, failure and privacy checks.
// - "bullmq-otel-lazy": the documented note for apps that keep bullmq-otel.
// - "bullmq-otel": `new BullMQOtel()` at import time, what the docs used to say. It records no
//   BullMQ span; if this starts failing, bullmq-otel has changed and the docs should be revisited.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  address,
  skipReason,
  tcpOpen,
  waitUntil,
} from "../integrations/helpers.js";

const reason = skipReason("redis");
const EXAMPLE = fileURLToPath(
  new URL("../../../../examples/bullmq-esm/", import.meta.url),
);

/** OTLP span kinds (the protocol's enum, not the API's). */
const KIND = { INTERNAL: 1, SERVER: 2, PRODUCER: 4, CONSUMER: 5 } as const;
const STATUS_ERROR = 2;

interface Got {
  service: string;
  scope: string;
  name: string;
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  status: number;
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
}

type Kv = { key: string; value: Record<string, unknown> };
const attrs = (list: Kv[] | undefined): Record<string, unknown> =>
  Object.fromEntries(
    (list ?? []).map((kv) => [kv.key, Object.values(kv.value)[0]]),
  );

async function receiver() {
  const spans: Got[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const rs of body.resourceSpans ?? []) {
          const service = String(
            attrs(rs.resource?.attributes)["service.name"],
          );
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) {
              spans.push({
                service,
                scope: ss.scope?.name,
                name: s.name,
                kind: s.kind,
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId || undefined,
                status: s.status?.code ?? 0,
                attributes: attrs(s.attributes),
                events: (s.events ?? []).map(
                  (e: { name: string; attributes?: Kv[] }) => ({
                    name: e.name,
                    attributes: attrs(e.attributes),
                  }),
                ),
              });
            }
          }
        }
      } catch {
        // A malformed post fails the assertions, not the server.
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    spans,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

type Mode = "nestrix" | "bullmq-otel-lazy" | "bullmq-otel";

interface Run {
  queue: string;
  spans: Got[];
  stderr: string;
}

function start(
  script: string,
  env: Record<string, string>,
): Promise<{ child: ChildProcess; line: string; stderr: () => string }> {
  const child = spawn(process.execPath, [script], {
    cwd: EXAMPLE,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} did not start in 20 s: ${stderr}`));
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${script} exited with ${code}: ${stderr}`));
    });
    child.stdout?.on("data", (d) => {
      const line = String(d).split("\n")[0] ?? "";
      if (line.startsWith("listening") || line.startsWith("ready")) {
        clearTimeout(timer);
        child.removeAllListeners("exit");
        resolve({ child, line, stderr: () => stderr });
      }
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

const children: ChildProcess[] = [];

async function run(mode: Mode): Promise<Run> {
  const otlp = await receiver();
  const redis = address("redis");
  const queue = `jobs-${mode}-${process.pid}-${Date.now()}`;
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    BULLMQ_TELEMETRY: mode,
    QUEUE: queue,
    REDIS_HOST: redis.host,
    REDIS_PORT: String(redis.port),
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otlp.url,
  } as Record<string, string>;
  const [api, worker] = await Promise.all([
    start("dist/main.js", { ...env, SERVICE_NAME: "api" }),
    start("dist/worker.js", { ...env, SERVICE_NAME: "worker" }),
  ]);
  children.push(api.child, worker.child);
  try {
    const base = api.line.split(" ")[1];
    for (const path of ["/ok", "/fail"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      await res.text();
    }
    // Both jobs ran (the processor's method spans reached the receiver).
    await waitUntil(
      async () => {
        const n = otlp.spans.filter(
          (s) => s.name === "JobsProcessor.process",
        ).length;
        if (n < 2) throw new Error(`${n} processor spans`);
      },
      15_000,
      `${mode}: both jobs processed`,
    );
  } finally {
    // A clean shutdown flushes what is left (the outcome spans end after the processor's).
    await Promise.all([stop(api.child), stop(worker.child)]);
    await otlp.close();
  }
  return { queue, spans: otlp.spans, stderr: api.stderr() + worker.stderr() };
}

describe.skipIf(reason !== undefined)(
  "BullMQ spans in a built ESM app under plain node (issue #20)",
  () => {
    const runs = new Map<Mode, Run>();

    beforeAll(async () => {
      if (
        !existsSync(`${EXAMPLE}dist/main.js`) ||
        !existsSync(`${EXAMPLE}dist/worker.js`)
      ) {
        throw new Error(
          "examples/bullmq-esm is not built: run `pnpm build` first",
        );
      }
      await waitUntil(() => tcpOpen(address("redis")), 30_000, "redis");
      const modes: Mode[] = ["nestrix", "bullmq-otel-lazy", "bullmq-otel"];
      const results = await Promise.all(modes.map(run));
      for (const [i, m] of modes.entries()) runs.set(m, results[i] as Run);
    }, 60_000);

    afterAll(async () => {
      await Promise.all(children.map(stop));
    });

    const get = (mode: Mode) => {
      const r = runs.get(mode);
      if (r === undefined) throw new Error(`no run for ${mode}`);
      const one = (pred: (s: Got) => boolean, what: string): Got => {
        const found = r.spans.filter(pred);
        if (found.length !== 1) {
          throw new Error(
            `${mode}: expected one ${what}, got ${found.length}: ${r.spans.map((s) => `${s.service}/${s.scope}/${s.name}`).join(", ")}\n${r.stderr}`,
          );
        }
        return found[0] as Got;
      };
      const childOf = (parent: Got, name: string): Got =>
        one(
          (s) => s.name === name && s.parentSpanId === parent.spanId,
          `${name} under ${parent.name}`,
        );
      return { ...r, one, childOf };
    };

    it("bullmqTelemetry() written inline in BullModule.forRoot(): producer in the API, consumer and complete in the worker, one trace", () => {
      const { queue, one, childOf, spans } = get("nestrix");
      const controller = one(
        (s) => s.name === "JobsController.ok",
        "JobsController.ok",
      );
      const producer = childOf(controller, `add ${queue}.email`);
      expect([producer.service, producer.scope, producer.kind]).toEqual([
        "api",
        "fixture",
        KIND.PRODUCER,
      ]);

      const consumer = childOf(producer, `process ${queue}`);
      expect([consumer.service, consumer.scope, consumer.kind]).toEqual([
        "worker",
        "fixture",
        KIND.CONSUMER,
      ]);
      expect(consumer.traceId).toBe(controller.traceId);
      expect(consumer.status).not.toBe(STATUS_ERROR);
      expect(consumer.attributes).toMatchObject({ "bullmq.job.name": "email" });

      const method = childOf(consumer, "JobsProcessor.process");
      expect([method.service, method.scope]).toEqual([
        "worker",
        "@nestrix-js/nestjs",
      ]);
      const complete = childOf(consumer, `complete ${queue}`);
      expect([complete.service, complete.kind]).toEqual([
        "worker",
        KIND.INTERNAL,
      ]);

      // The job's return value ("sent") is never recorded.
      const completed = consumer.events.find((e) => e.name === "job completed");
      expect(completed?.attributes).toEqual({});
      expect(JSON.stringify(spans)).not.toContain("bullmq.job.result");

      // No parentless BullMQ housekeeping span (stalled-jobs check, close) by default.
      expect(
        spans
          .filter((s) => s.scope === "fixture" && s.parentSpanId === undefined)
          .map((s) => s.name),
      ).toEqual([]);
    });

    it("a failing job: the process span carries the exception and error status, with fail under it", () => {
      const { queue, one, childOf } = get("nestrix");
      const controller = one(
        (s) => s.name === "JobsController.fail",
        "JobsController.fail",
      );
      const producer = childOf(controller, `add ${queue}.boom`);
      const consumer = childOf(producer, `process ${queue}`);
      expect(consumer.status).toBe(STATUS_ERROR);
      expect(consumer.events.map((e) => e.name)).toEqual(
        expect.arrayContaining(["job failed", "exception"]),
      );
      expect(
        consumer.events.find((e) => e.name === "exception")?.attributes,
      ).toMatchObject({
        "exception.message": "boom: the job failed on purpose",
      });
      const fail = childOf(consumer, `fail ${queue}`);
      expect([fail.service, fail.kind]).toEqual(["worker", KIND.INTERNAL]);
      const method = childOf(consumer, "JobsProcessor.process");
      expect(method.status).toBe(STATUS_ERROR);
    });

    it("bullmq-otel created on first use (the documented note) also records producer and consumer spans", () => {
      const { queue, one, childOf } = get("bullmq-otel-lazy");
      const controller = one(
        (s) => s.name === "JobsController.ok",
        "JobsController.ok",
      );
      const producer = childOf(controller, `add ${queue}.email`);
      const consumer = childOf(producer, `process ${queue}`);
      childOf(consumer, `complete ${queue}`);
      childOf(consumer, "JobsProcessor.process");
    });

    it("new BullMQOtel() at import time (the old docs) records no BullMQ span; the processor hangs off the controller", () => {
      const { spans, one } = get("bullmq-otel");
      expect(
        spans.filter((s) => s.scope === "fixture").map((s) => s.name),
      ).toEqual([]);
      const controller = one(
        (s) => s.name === "JobsController.ok",
        "JobsController.ok",
      );
      const methods = spans.filter((s) => s.name === "JobsProcessor.process");
      expect(methods.map((m) => m.parentSpanId)).toContain(controller.spanId);
    });
  },
);
