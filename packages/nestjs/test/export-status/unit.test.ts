// D-82 (#21, #39): failure classification, the status's state machine and its log lines, the
// observing exporter wrapper, and rule 1 for each (a throwing logger, tracker or exporter result
// changes nothing the SDK sees).
import { ExportResultCode } from "@opentelemetry/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  activateExport,
  deactivateExport,
  exportStatusLog,
  getExportStatus,
  recordExportDropped,
  recordExportFailure,
  recordExportStopped,
  recordExportSuccess,
  resetExportStatusForTests,
} from "../../src/export-status.js";
import { getExportStatus as publicGetExportStatus } from "../../src/index.js";
import {
  classifyExportError,
  observeExports,
} from "../../src/otel/observe-export.js";

let warn: MockInstance<(message: string) => void>;
let info: MockInstance<(message: string) => void>;

beforeEach(() => {
  resetExportStatusForTests();
  warn = vi.spyOn(exportStatusLog, "warn").mockImplementation(() => {});
  info = vi.spyOn(exportStatusLog, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

class OTLPExporterError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

describe("classifyExportError", () => {
  it.each([
    [
      new OTLPExporterError("Unauthorized", 401),
      undefined,
      "unauthorized",
      401,
    ],
    [new OTLPExporterError("Forbidden", 403), undefined, "unauthorized", 403],
    [new OTLPExporterError("Not Found", 404), undefined, "not_supported", 404],
    [new OTLPExporterError("", 405), undefined, "not_supported", 405],
    [new OTLPExporterError("", 501), undefined, "not_supported", 501],
    [new OTLPExporterError("", 500), undefined, "server_error", 500],
    [new OTLPExporterError("", 400), undefined, "other", 400],
    [new OTLPExporterError("", 408), undefined, "timeout", 408],
    // The exporter's error for a retried status carries no code: the observed status decides.
    [
      new OTLPExporterError("Export failed with retryable status"),
      429,
      "rate_limited",
      429,
    ],
    [
      new OTLPExporterError("Export failed with retryable status"),
      503,
      "server_error",
      503,
    ],
    [
      new OTLPExporterError("Export failed with retryable status"),
      undefined,
      "other",
      null,
    ],
    [
      Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      undefined,
      "unreachable",
      null,
    ],
    [
      Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
      undefined,
      "unreachable",
      null,
    ],
    [
      Object.assign(
        new AggregateError([
          Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
        ]),
        {},
      ),
      undefined,
      "unreachable",
      null,
    ],
    [
      Object.assign(new Error("t"), { code: "ETIMEDOUT" }),
      undefined,
      "timeout",
      null,
    ],
    [new Error("Request timed out"), 503, "timeout", null],
    [new Error("Timeout"), undefined, "timeout", null],
    [undefined, undefined, "other", null],
    ["a string", undefined, "other", null],
  ] as const)("%s (observed %s) -> %s", (error, observed, reason, status) => {
    expect(classifyExportError(error, observed)).toEqual({
      reason,
      httpStatus: status,
    });
  });

  it("an error whose properties throw is `other`", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter");
        },
      },
    );
    expect(classifyExportError(hostile, undefined)).toEqual({
      reason: "other",
      httpStatus: null,
    });
  });
});

describe("export status", () => {
  it("is inactive for every signal until Nestrix's own exporter starts, also through the public export", () => {
    const status = publicGetExportStatus();
    expect(status.degraded).toBe(false);
    for (const signal of ["traces", "logs", "metrics"] as const) {
      expect(status[signal]).toMatchObject({
        state: "inactive",
        lastSuccessAt: null,
        lastFailure: null,
        consecutiveFailures: 0,
        dropped: 0,
      });
    }
    // Records for an inactive signal are ignored.
    recordExportFailure("traces", { reason: "unreachable", httpStatus: null });
    recordExportDropped("traces", 5);
    expect(getExportStatus().traces.state).toBe("inactive");
    expect(getExportStatus().traces.dropped).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once when a signal starts failing, once per other reason, and logs one line on recovery", () => {
    activateExport("traces");
    expect(getExportStatus().traces.state).toBe("pending");
    recordExportSuccess("traces");
    expect(info).not.toHaveBeenCalled(); // no recovery line without a failure

    for (let i = 0; i < 5; i++) {
      recordExportFailure("traces", {
        reason: "unreachable",
        httpStatus: null,
      });
    }
    recordExportDropped("traces", 7);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^Exports of spans to the OTLP endpoint are failing \(unreachable: /,
    );
    let traces = getExportStatus().traces;
    expect(traces).toMatchObject({
      state: "failing",
      consecutiveFailures: 5,
      lastFailure: { reason: "unreachable", httpStatus: null },
      dropped: 7,
    });
    expect(traces.failures.unreachable).toBe(5);
    expect(getExportStatus().degraded).toBe(true);

    recordExportFailure("traces", { reason: "unauthorized", httpStatus: 401 });
    recordExportFailure("traces", { reason: "unauthorized", httpStatus: 401 });
    recordExportFailure("traces", { reason: "unreachable", httpStatus: null });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toContain("unauthorized, HTTP 401");

    recordExportSuccess("traces");
    recordExportSuccess("traces");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe(
      "Exporting spans to the OTLP endpoint works again, after 8 failed exports; 7 spans were dropped from the queue meanwhile.",
    );
    traces = getExportStatus().traces;
    expect(traces.state).toBe("ok");
    expect(traces.consecutiveFailures).toBe(0);
    expect(traces.failures).toMatchObject({ unreachable: 6, unauthorized: 2 });
    expect(traces.lastSuccessAt).toBeGreaterThan(0);
    expect(getExportStatus().degraded).toBe(false);

    // A new episode warns again.
    recordExportFailure("traces", { reason: "rate_limited", httpStatus: 429 });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("stops a signal with one warning and ignores later results", () => {
    activateExport("metrics");
    recordExportStopped(
      "metrics",
      { reason: "not_supported", httpStatus: 404 },
      "stopped",
    );
    recordExportStopped(
      "metrics",
      { reason: "not_supported", httpStatus: 404 },
      "stopped",
    );
    recordExportSuccess("metrics");
    recordExportFailure("metrics", { reason: "other", httpStatus: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getExportStatus().metrics).toMatchObject({
      state: "stopped",
      consecutiveFailures: 1,
      lastFailure: { reason: "not_supported", httpStatus: 404 },
    });
    expect(getExportStatus().degraded).toBe(true);
    deactivateExport("metrics");
    expect(getExportStatus().metrics.state).toBe("inactive");
    expect(getExportStatus().degraded).toBe(false);
  });

  it("returns frozen snapshots a caller cannot use to change the status", () => {
    activateExport("logs");
    const status = getExportStatus();
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.logs.failures)).toBe(true);
    expect(() => {
      (status.logs.failures as Record<string, number>).other = 9;
    }).toThrow();
    expect(getExportStatus().logs.failures.other).toBe(0);
  });

  it("rule 1: a logger that throws changes nothing", () => {
    warn.mockImplementation(() => {
      throw new Error("logger down");
    });
    info.mockImplementation(() => {
      throw new Error("logger down");
    });
    activateExport("logs");
    expect(() =>
      recordExportFailure("logs", { reason: "timeout", httpStatus: null }),
    ).not.toThrow();
    expect(() => recordExportSuccess("logs")).not.toThrow();
    expect(getExportStatus().logs.state).toBe("ok");
  });
});

describe("observeExports", () => {
  function scripted(results: { code: number; error?: unknown }[]) {
    const calls: unknown[] = [];
    return {
      calls,
      export(items: unknown, cb: (r: { code: number; error?: Error }) => void) {
        calls.push(items);
        cb((results.shift() ?? { code: ExportResultCode.SUCCESS }) as never);
      },
      shutdown: vi.fn(async () => {}),
      forceFlush: vi.fn(async () => {}),
      selectAggregationTemporality: function (this: unknown) {
        return this;
      },
    };
  }

  it("passes every result on unchanged and records it", () => {
    activateExport("traces");
    const failure = {
      code: ExportResultCode.FAILED,
      error: new OTLPExporterError("x", 403),
    };
    const inner = scripted([failure, { code: ExportResultCode.SUCCESS }]);
    const wrapped = observeExports(inner, { signal: "traces" });
    const seen: unknown[] = [];
    wrapped.export([1], (r) => seen.push(r));
    wrapped.export([2], (r) => seen.push(r));
    expect(seen).toEqual([failure, { code: ExportResultCode.SUCCESS }]);
    expect(getExportStatus().traces.failures.unauthorized).toBe(1);
    expect(getExportStatus().traces.state).toBe("ok");
  });

  it("copies the metric reader's selector methods, bound to the inner exporter", () => {
    const inner = scripted([]);
    const wrapped = observeExports(inner, { signal: "metrics" }) as unknown as {
      selectAggregationTemporality(): unknown;
      selectAggregation?: unknown;
    };
    expect(wrapped.selectAggregationTemporality()).toBe(inner);
    expect(wrapped.selectAggregation).toBeUndefined();
  });

  it("uses the tracker's status for a retried status, and clears it before each export", () => {
    activateExport("logs");
    const tracker = { lastStatus: undefined as number | undefined };
    const generic = {
      code: ExportResultCode.FAILED,
      error: new OTLPExporterError("Export failed with retryable status"),
    };
    const inner = {
      export(_: unknown, cb: (r: typeof generic) => void) {
        expect(tracker.lastStatus).toBeUndefined();
        tracker.lastStatus = 429;
        cb(generic);
      },
      shutdown: async () => {},
    };
    const wrapped = observeExports(inner, { signal: "logs", tracker });
    tracker.lastStatus = 503;
    wrapped.export([], () => {});
    expect(getExportStatus().logs.lastFailure).toEqual({
      reason: "rate_limited",
      httpStatus: 429,
    });
  });

  it("with onNotSupported: calls it once on 404 and sends nothing after", () => {
    activateExport("metrics");
    const inner = scripted([
      {
        code: ExportResultCode.FAILED,
        error: new OTLPExporterError("Not Found", 404),
      },
    ]);
    const onNotSupported = vi.fn();
    const wrapped = observeExports(inner, {
      signal: "metrics",
      onNotSupported,
    });
    const seen: { code: number }[] = [];
    wrapped.export("a", (r) => seen.push(r));
    wrapped.export("b", (r) => seen.push(r));
    wrapped.export("c", (r) => seen.push(r));
    expect(inner.calls).toEqual(["a"]);
    expect(seen.map((r) => r.code)).toEqual([
      ExportResultCode.FAILED,
      ExportResultCode.SUCCESS,
      ExportResultCode.SUCCESS,
    ]);
    expect(onNotSupported).toHaveBeenCalledTimes(1);
    expect(onNotSupported).toHaveBeenCalledWith({
      reason: "not_supported",
      httpStatus: 404,
    });
  });

  it("without onNotSupported: a 404 is a failure like any other, and exports continue", () => {
    activateExport("traces");
    const inner = scripted([
      {
        code: ExportResultCode.FAILED,
        error: new OTLPExporterError("Not Found", 404),
      },
    ]);
    const wrapped = observeExports(inner, { signal: "traces" });
    wrapped.export("a", () => {});
    wrapped.export("b", () => {});
    expect(inner.calls).toEqual(["a", "b"]);
    expect(getExportStatus().traces.failures.not_supported).toBe(1);
  });

  it("rule 1: a throwing tracker, onNotSupported or result getter still reaches the callback once", () => {
    activateExport("metrics");
    const tracker = {};
    Object.defineProperty(tracker, "lastStatus", {
      get() {
        throw new Error("get");
      },
      set() {
        throw new Error("set");
      },
    });
    const hostileResult = {
      get code(): number {
        throw new Error("code");
      },
    };
    const inner = {
      export(_: unknown, cb: (r: unknown) => void) {
        cb(hostileResult);
      },
      shutdown: async () => {},
    };
    const wrapped = observeExports(inner as never, {
      signal: "metrics",
      tracker: tracker as never,
      onNotSupported: () => {
        throw new Error("boom");
      },
    });
    const cb = vi.fn();
    expect(() => wrapped.export([], cb)).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toBe(hostileResult);
  });

  it("a synchronous throw from the inner exporter is passed on, as before", () => {
    const inner = {
      export() {
        throw new Error("sync");
      },
      shutdown: async () => {},
    };
    const wrapped = observeExports(inner, { signal: "traces" });
    expect(() => wrapped.export([], () => {})).toThrow("sync");
  });
});
