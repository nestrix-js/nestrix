// setupLogExport against a local OTLP stub, with the real optional packages; the missing-package
// path through an injectable loader; a host LoggerProvider.
import "reflect-metadata";
import { logs, trace } from "@opentelemetry/api";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { type LogExportLoader, setupLogExport } from "../../src/logs/export.js";
import { NestrixLogger } from "../../src/logs/logger.js";
import { getLogSink } from "../../src/logs/sink.js";
import { resolveOptions } from "../../src/resolve-options.js";
import { recordingDiagnostics } from "../otel-helpers.js";
import {
  captureOutput,
  type LogReceiver,
  registerHostTracing,
  startLogReceiver,
} from "./helpers.js";

let receiver: LogReceiver;
let undoTracing: () => void;
let output: ReturnType<typeof captureOutput>;

beforeEach(async () => {
  resetDiagnosticsForTests();
  receiver = await startLogReceiver();
  undoTracing = registerHostTracing();
  output = captureOutput();
});
afterEach(async () => {
  output.restore();
  undoTracing();
  await receiver.close();
});

function options(
  env: Record<string, string> = {},
  logsOption: { export?: boolean } = { export: true },
) {
  return resolveOptions(
    {
      serviceName: "logs-test",
      logs: logsOption,
      export: { otlp: { endpoint: receiver.baseUrl, timeoutMillis: 2000 } },
    },
    env,
  );
}

async function ready(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!getLogSink()) {
    if (Date.now() > deadline) throw new Error("log sink never became ready");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("resolveOptions: logs", () => {
  it("is off by default and resolves the logs URL when on", () => {
    expect(
      resolveOptions({ export: { otlp: { endpoint: "http://x:4318" } } }, {})
        .logs,
    ).toEqual({
      export: false,
      otlp: false,
    });
    const on = resolveOptions(
      {
        logs: { export: true },
        export: { otlp: { endpoint: "http://x:4318/" } },
      },
      {},
    );
    expect(on.logs.otlp).toMatchObject({ url: "http://x:4318/v1/logs" });
  });

  it("honours OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as given, then the generic endpoint", () => {
    const signal = resolveOptions(
      { logs: { export: true } },
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://logs:1/custom",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://generic:2",
      },
    );
    expect(signal.logs.otlp).toMatchObject({ url: "http://logs:1/custom" });
    const generic = resolveOptions(
      { logs: { export: true } },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://generic:2" },
    );
    expect(generic.logs.otlp).toMatchObject({
      url: "http://generic:2/v1/logs",
    });
    // Traces are unaffected by the logs variable.
    expect(signal.export.otlp).toMatchObject({
      url: "http://generic:2/v1/traces",
    });
  });
});

describe("log export with the packages installed", () => {
  it("sends records to /v1/logs with severity, context, ids and resource", async () => {
    const diag = recordingDiagnostics();
    const handle = setupLogExport(options(), diag);
    await ready();
    const logger = new NestrixLogger({ colors: false });
    logger.log("plain info", "MyContext");
    logger.warn("a warning");
    logger.error("it broke", "Error: stack line", "Failing");
    logger.verbose("very detailed");
    let spanIds = { traceId: "", spanId: "" };
    trace.getTracer("t").startActiveSpan("s", (span) => {
      spanIds = span.spanContext();
      logger.log("inside span", "Ctx");
      span.end();
    });
    await handle?.shutdown();

    const byBody = new Map(receiver.logs.map((l) => [l.body, l]));
    expect(receiver.logs).toHaveLength(5);
    expect(byBody.get("plain info")).toMatchObject({
      severityNumber: 9,
      severityText: "LOG",
      attributes: { "nestrix.log.context": "MyContext" },
      traceId: undefined,
    });
    expect(byBody.get("a warning")?.severityNumber).toBe(13);
    expect(byBody.get("it broke")).toMatchObject({
      severityNumber: 17,
      attributes: {
        "nestrix.log.context": "Failing",
        "exception.stacktrace": "Error: stack line",
      },
    });
    expect(byBody.get("very detailed")?.severityNumber).toBe(1);
    const inside = byBody.get("inside span");
    expect(inside?.traceId).toBe(spanIds.traceId);
    expect(inside?.spanId).toBe(spanIds.spanId);
    expect(inside?.resource["service.name"]).toBe("logs-test");
    expect(receiver.paths.every((p) => p === "POST /v1/logs")).toBe(true);
    expect(diag.failures).toEqual([]);
    expect(getLogSink()).toBeUndefined();
  });

  it("does not export when logs.export is off", async () => {
    const handle = setupLogExport(
      options({}, { export: false }),
      recordingDiagnostics(),
    );
    expect(handle).toBeUndefined();
    new NestrixLogger({ colors: false }).log("not exported");
    expect(getLogSink()).toBeUndefined();
    expect(receiver.logs).toEqual([]);
  });

  it("says once that there is no endpoint, and exports nothing", () => {
    const diag = recordingDiagnostics();
    const handle = setupLogExport(
      resolveOptions({ logs: { export: true } }, {}),
      diag,
    );
    expect(handle).toBeUndefined();
    expect(diag.logs.get("logs.no-endpoint")).toContain(
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    );
  });
});

describe("missing packages", () => {
  it("logs one line with the install command, sets nothing up and keeps logging", async () => {
    const diag = recordingDiagnostics();
    const loader: LogExportLoader = () =>
      Promise.reject(
        new Error("Cannot find package '@opentelemetry/sdk-logs'"),
      );
    const handle = setupLogExport(options(), diag, loader);
    await handle?.shutdown();
    expect([...diag.logs.keys()]).toEqual(["logs.packages-missing"]);
    expect(diag.logs.get("logs.packages-missing")).toContain(
      "npm install @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http",
    );
    expect(diag.failures).toEqual([]);
    expect(getLogSink()).toBeUndefined();
    expect(() =>
      new NestrixLogger({ colors: false }).log("still prints"),
    ).not.toThrow();
    expect(output.lines().join("\n")).toContain("still prints");
    expect(receiver.logs).toEqual([]);
  });
});

describe("a host LoggerProvider", () => {
  it("receives the records; Nestrix sends nothing and leaves the provider registered", async () => {
    const memory = new InMemoryLogRecordExporter();
    const host = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter: memory })],
    });
    expect(logs.setGlobalLoggerProvider(host)).toBe(true);
    try {
      const diag = recordingDiagnostics();
      const handle = setupLogExport(options(), diag);
      await ready();
      new NestrixLogger({ colors: false }).log("to the host", "Ctx");
      await handle?.shutdown();
      const records = memory.getFinishedLogRecords();
      expect(records.map((r) => r.body)).toEqual(["to the host"]);
      expect(records[0]?.attributes["nestrix.log.context"]).toBe("Ctx");
      expect(receiver.logs).toEqual([]);
      // The host's provider is still the registered one and still works.
      expect(logs.getLoggerProvider()).toBe(host);
      expect(diag.failures).toEqual([]);
    } finally {
      logs.disable();
      await host.shutdown();
    }
  });
});

describe("failures are counted, never thrown", () => {
  it("a throwing provider constructor is counted at logs.setup", async () => {
    const diag = recordingDiagnostics();
    const loader: LogExportLoader = () =>
      Promise.resolve({
        LoggerProvider: class {
          constructor() {
            throw new Error("bad provider");
          }
        } as never,
        BatchLogRecordProcessor: class {} as never,
        OTLPLogExporter: class {} as never,
      });
    const handle = setupLogExport(options(), diag, loader);
    await vi.waitFor(() => expect(diag.failures).toHaveLength(1));
    await handle?.shutdown();
    expect(diag.failures.map((f) => f.where)).toEqual(["logs.setup"]);
    expect(getLogSink()).toBeUndefined();
    expect(getFailureCounts().size).toBe(0);
  });
});
