// End to end: NestrixModule with logs.export on, NestrixLogger as the app logger, a request that
// logs inside its server span and a log line outside any request.
import "reflect-metadata";
import { Controller, Get, Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestrixLogger } from "../../src/logs/logger.js";
import { getLogSink } from "../../src/logs/sink.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  captureOutput,
  type LogReceiver,
  startLogReceiver,
} from "./helpers.js";

let receiver: LogReceiver;

@Controller()
class WorkController {
  private readonly logger = new Logger("Work");
  @Get("work")
  work(): string {
    this.logger.log("inside the request");
    return "ok";
  }
}

beforeAll(async () => {
  receiver = await startLogReceiver();
});
afterAll(async () => {
  await receiver.close();
});

describe("NestrixLogger in a Nest app with logs.export", () => {
  it("correlates the request's lines, exports them to /v1/logs, and flushes on close", async () => {
    @Module({
      imports: [
        NestrixModule.forRoot({
          ui: false,
          logs: { export: true },
          export: { otlp: { endpoint: receiver.baseUrl, timeoutMillis: 2000 } },
        }),
      ],
      controllers: [WorkController],
    })
    class TestModule {}

    const output = captureOutput();
    let lines: string[];
    try {
      const app = await NestFactory.create(TestModule, {
        logger: new NestrixLogger({ colors: false }),
      });
      await app.listen(0, "127.0.0.1");
      const { port } = app.getHttpServer().address() as { port: number };
      const deadline = Date.now() + 5000;
      while (!getLogSink()) {
        if (Date.now() > deadline)
          throw new Error("log export never became ready");
        await new Promise((r) => setTimeout(r, 5));
      }
      new Logger("Outside").log("outside any request");
      const res = await fetch(`http://127.0.0.1:${port}/work`);
      expect(await res.text()).toBe("ok");
      await app.close();
      lines = output.lines();
    } finally {
      output.restore();
    }

    const inside = lines.find((l) => l.includes("inside the request"));
    const outside = lines.find((l) => l.includes("outside any request"));
    expect(inside).toMatch(/ trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16}$/);
    expect(outside).not.toContain("trace_id");

    const exportedInside = receiver.logs.find(
      (l) => l.body === "inside the request",
    );
    const exportedOutside = receiver.logs.find(
      (l) => l.body === "outside any request",
    );
    expect(exportedInside?.attributes["nestrix.log.context"]).toBe("Work");
    expect(inside).toContain(`trace_id=${exportedInside?.traceId}`);
    expect(exportedInside?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(exportedOutside?.traceId).toBeUndefined();
    expect(getLogSink()).toBeUndefined();
  });
});
