// Uses the subpath as a consumer would: through the package's own exports (built dist), not src.
import "reflect-metadata";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixModule, Span, withSpan } from "@nestrix-js/nestjs";
import {
  createInMemorySpanCapture,
  type InMemorySpanCapture,
} from "@nestrix-js/nestjs/testing";
import { trace } from "@opentelemetry/api";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

@Injectable()
class MailService {
  @Span("mail.send")
  async send(): Promise<string> {
    return withSpan("mail.render", (span) => {
      span.setAttribute("mail.transport", "smtp");
      return "sent";
    });
  }
}

@Controller()
class AppController {
  constructor(private readonly mail: MailService) {}

  @Get("/hello")
  hello(): Promise<string> {
    return this.mail.send();
  }
}

@Module({
  imports: [NestrixModule.forRoot({ serviceName: "testing-subpath" })],
  controllers: [AppController],
  providers: [MailService],
})
class AppModule {}

describe("@nestrix-js/nestjs/testing", () => {
  let capture: InMemorySpanCapture;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;

  beforeAll(async () => {
    capture = createInMemorySpanCapture();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await app.close();
    await capture.shutdown();
  });
  beforeEach(() => capture.reset());

  it("captures the spans a Nest app finishes, with their attributes", async () => {
    const res = await fetch(`${baseUrl}/hello`);
    expect(await res.text()).toBe("sent");
    await vi.waitFor(() => {
      expect(
        capture.findSpan((s) => s.attributes["http.route"] === "/hello"),
      ).toBeDefined();
    });
    const render = capture.findSpan("mail.render");
    expect(render?.attributes["mail.transport"]).toBe("smtp");
    expect(capture.findSpan("mail.send")).toBeDefined();
    expect(capture.spans().length).toBeGreaterThanOrEqual(3);
    // Parenting works: the helper registered a context manager.
    const send = capture.findSpan("mail.send");
    expect(render?.parentSpanContext?.spanId).toBe(send?.spanContext().spanId);
  });

  it("reset() forgets spans and findSpan returns undefined for a missing name", () => {
    expect(capture.spans()).toEqual([]);
    expect(capture.findSpan("mail.send")).toBeUndefined();
  });

  it("refuses a second capture while one is registered, and works again after shutdown", async () => {
    expect(() => createInMemorySpanCapture()).toThrow(/already registered/);
    await app.close();
    await capture.shutdown();
    await capture.shutdown(); // idempotent
    expect(trace.getTracerProvider().constructor.name).not.toBe(
      "TracerProvider",
    );
    const again = createInMemorySpanCapture();
    trace.getTracer("t").startSpan("x").end();
    expect(again.findSpan("x")).toBeDefined();
    await again.shutdown();
    // afterAll closes the app and the first capture again; both are idempotent.
    capture = createInMemorySpanCapture();
    app = await NestFactory.create(AppModule, { logger: false });
  });
});
