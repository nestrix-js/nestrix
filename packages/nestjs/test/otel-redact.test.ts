// Global state: no host SDK; a Nest app with Nestrix's pipeline, a scrub step and a user
// redact hook whose behaviour depends on the span name.
import "reflect-metadata";
import {
  Controller,
  Get,
  Injectable,
  Module,
  type OnApplicationShutdown,
  Query,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RedactableSpan } from "../src/options.js";
import { setupTelemetry } from "../src/otel/setup.js";
import type { TelemetryHandle } from "../src/otel/types.js";
import {
  config,
  otlp,
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";

let receiver: Receiver;
const diagnostics = recordingDiagnostics();
const hookSaw: Record<string, unknown> = {};

function scrub(span: RedactableSpan): void {
  if (span.name === "scrub-throw") throw new Error("scrub fault");
  if ("http.request.header.authorization" in span.attributes) {
    span.attributes["http.request.header.authorization"] = "REDACTED";
  }
  span.attributes["test.scrubbed"] = true;
}

function redact(span: RedactableSpan): boolean | undefined {
  hookSaw[span.name] = span.attributes["test.scrubbed"];
  switch (span.name) {
    case "redact-throw":
      throw new Error("user hook fault");
    case "redact-drop":
      return false;
    case "redact-edit": {
      delete span.attributes.secret;
      span.attributes.replaced = "yes";
      span.attributes.nested = { not: "allowed" };
      const event = span.events[0];
      if (event) event.attributes["exception.message"] = "[hidden]";
      span.status.message = "[hidden]";
      return true;
    }
    case "redact-null-attributes":
      (span as { attributes: unknown }).attributes = null;
      return undefined;
    default:
      return undefined;
  }
}

@Injectable()
class TelemetryCore implements OnApplicationShutdown {
  readonly handle: TelemetryHandle;
  constructor() {
    this.handle = setupTelemetry(
      config({
        export: {
          otlp: otlp(receiver.url),
          queue: {
            maxQueueSize: 100,
            maxExportBatchSize: 100,
            scheduledDelayMillis: 10,
          },
        },
        scrub,
        redact,
      }),
      diagnostics,
    );
  }
  onApplicationShutdown(): Promise<void> {
    return this.handle.shutdown();
  }
}

@Controller()
class SpanController {
  @Get("span")
  span(@Query("name") name: string): string {
    const span = trace.getTracer("app").startSpan(name, {
      attributes: {
        secret: "s3cr3t",
        keep: "k",
        "http.request.header.authorization": "Bearer abc",
      },
    });
    span.recordException(new Error("password=hunter2"));
    span.setStatus({ code: 2, message: "password=hunter2" });
    span.end();
    return "ok";
  }
}

@Module({ controllers: [SpanController], providers: [TelemetryCore] })
class TestModule {}

beforeAll(async () => {
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver.close();
});

describe("redaction in the owned pipeline", () => {
  it("applies scrub then redact, drops on false or throw, and the app keeps serving", async () => {
    const app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as { port: number };
    const names = [
      "plain",
      "redact-throw",
      "redact-drop",
      "redact-edit",
      "scrub-throw",
      "redact-null-attributes",
      "after-faults",
    ];
    for (const name of names) {
      const res = await fetch(`http://127.0.0.1:${port}/span?name=${name}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }
    const core = app.get(TelemetryCore);
    await app.close();

    const byName = new Map(receiver.spans.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual([
      "after-faults",
      "plain",
      "redact-edit",
    ]);

    const plain = byName.get("plain");
    expect(plain?.attributes).toMatchObject({
      secret: "s3cr3t",
      keep: "k",
      "http.request.header.authorization": "REDACTED",
      "test.scrubbed": true,
    });
    expect(plain?.events[0]?.attributes["exception.message"]).toBe(
      "password=hunter2",
    );

    const edited = byName.get("redact-edit");
    expect(edited?.attributes).not.toHaveProperty("secret");
    expect(edited?.attributes).not.toHaveProperty("nested");
    expect(edited?.attributes).toMatchObject({ keep: "k", replaced: "yes" });
    expect(edited?.events[0]?.name).toBe("exception");
    expect(edited?.events[0]?.attributes["exception.message"]).toBe("[hidden]");
    expect(edited?.events[0]?.attributes["exception.type"]).toBe("Error");
    expect(edited?.status).toEqual({ code: 2, message: "[hidden]" });
    expect(plain?.status).toEqual({ code: 2, message: "password=hunter2" });

    // The hook ran after scrub (it saw scrub's attribute) and not for scrub-throw.
    expect(hookSaw.plain).toBe(true);
    expect(hookSaw).not.toHaveProperty("scrub-throw");

    expect(core.handle.counters.redactDroppedSpans).toBe(1);
    expect(core.handle.counters.redactFailedSpans).toBe(3);
    await expect.poll(() => core.handle.counters.exportedSpans).toBe(3);
    expect(diagnostics.failures.map((f) => f.where)).toEqual([
      "otel.redact",
      "otel.redact",
      "otel.redact",
    ]);
    expect(diagnostics.logs.has("otel.redact.invalid-value")).toBe(true);
  });
});
