import { describe, expect, it } from "vitest";
import { isDisabledByEnv, resolveOptions } from "../src/resolve-options.js";

const none = {};

describe("resolveOptions defaults", () => {
  it("applies every default with no options and an empty environment", () => {
    const r = resolveOptions(undefined, none);
    expect(r).toEqual({
      enabled: true,
      serviceName: undefined,
      resourceAttributes: {},
      sampleRate: 1,
      export: {
        otlp: false,
        queue: {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5000,
        },
      },
      ignore: { routes: [], outgoing: [] },
      http: { requestHeaders: [], responseHeaders: [], redactQueryKeys: [] },
      redact: undefined,
      ui: {
        mode: "auto",
        path: "/_nestrix",
        startupToken: true,
        auth: undefined,
      },
      store: { maxTraces: 5000, maxBytes: 33554432 },
    });
  });

  it("is deeply frozen", () => {
    const r = resolveOptions(
      {
        export: { otlp: { endpoint: "http://x:4318", headers: { a: "b" } } },
        ignore: { routes: ["/health"] },
      },
      none,
    );
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.export)).toBe(true);
    expect(Object.isFrozen(r.export.queue)).toBe(true);
    expect(Object.isFrozen(r.export.otlp)).toBe(true);
    expect(Object.isFrozen(r.ignore.routes)).toBe(true);
    expect(Object.isFrozen(r.http.requestHeaders)).toBe(true);
    expect(Object.isFrozen(r.resourceAttributes)).toBe(true);
    if (r.export.otlp)
      expect(Object.isFrozen(r.export.otlp.headers)).toBe(true);
  });

  it("does not alias the caller's arrays or objects", () => {
    const routes = ["/a"];
    const r = resolveOptions({ ignore: { routes } }, none);
    routes.push("/b");
    expect(r.ignore.routes).toEqual(["/a"]);
  });

  it("keeps matchers and the redact hook as given", () => {
    const re = /^\/h/;
    const fn = () => true;
    const redact = () => undefined;
    const r = resolveOptions(
      { ignore: { routes: [re], outgoing: [fn] }, redact },
      none,
    );
    expect(r.ignore.routes[0]).toBe(re);
    expect(r.ignore.outgoing[0]).toBe(fn);
    expect(r.redact).toBe(redact);
  });

  it("fills partial queue options from the defaults", () => {
    const r = resolveOptions(
      { export: { queue: { maxQueueSize: 4096 } } },
      none,
    );
    expect(r.export.queue).toEqual({
      maxQueueSize: 4096,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
    });
  });
});

describe("resolveOptions environment", () => {
  it("OTEL_SERVICE_NAME is the default service name; the option wins", () => {
    expect(
      resolveOptions({}, { OTEL_SERVICE_NAME: "from-env" }).serviceName,
    ).toBe("from-env");
    expect(
      resolveOptions({ serviceName: "opt" }, { OTEL_SERVICE_NAME: "from-env" })
        .serviceName,
    ).toBe("opt");
    expect(resolveOptions({}, { OTEL_SERVICE_NAME: "  " }).serviceName).toBe(
      undefined,
    );
  });

  it("OTEL_EXPORTER_OTLP_ENDPOINT gets /v1/traces appended", () => {
    for (const base of ["http://c:4318", "http://c:4318/", "http://c:4318//"]) {
      const r = resolveOptions({}, { OTEL_EXPORTER_OTLP_ENDPOINT: base });
      expect(r.export.otlp).toMatchObject({ url: "http://c:4318/v1/traces" });
    }
  });

  it("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is used as is and beats the generic one", () => {
    const r = resolveOptions(
      {},
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t:1/custom/path",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://g:2",
      },
    );
    expect(r.export.otlp).toMatchObject({ url: "http://t:1/custom/path" });
  });

  it("the endpoint option beats both and gets /v1/traces appended", () => {
    const r = resolveOptions(
      { export: { otlp: { endpoint: "http://opt:3/" } } },
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t:1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://g:2",
      },
    );
    expect(r.export.otlp).toMatchObject({ url: "http://opt:3/v1/traces" });
  });

  it("export.otlp: false disables export even when the environment sets an endpoint", () => {
    const r = resolveOptions(
      { export: { otlp: false } },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://g:2" },
    );
    expect(r.export.otlp).toBe(false);
  });

  it("an otlp object with no endpoint and none in the environment means no export", () => {
    expect(
      resolveOptions({ export: { otlp: { timeoutMillis: 5 } } }, none).export
        .otlp,
    ).toBe(false);
  });

  it("parses OTLP headers from the environment; traces headers win per key; options win over both", () => {
    const r = resolveOptions(
      { export: { otlp: { endpoint: "http://e", headers: { c: "opt" } } } },
      {
        OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=2, c = 3 ,bad,=x,d=%20sp%3Dace",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "b=two",
      },
    );
    expect(r.export.otlp).toMatchObject({
      headers: { a: "1", b: "two", c: "opt", d: " sp=ace" },
    });
  });

  it("keeps an undecodable header value as is instead of throwing", () => {
    const r = resolveOptions(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://e",
        OTEL_EXPORTER_OTLP_HEADERS: "a=%E0%A4%A",
      },
    );
    expect(r.export.otlp).toMatchObject({ headers: { a: "%E0%A4%A" } });
  });

  it("default OTLP timeout is 10000 and the option overrides it", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://e" };
    expect(resolveOptions({}, env).export.otlp).toMatchObject({
      timeoutMillis: 10000,
    });
    expect(
      resolveOptions({ export: { otlp: { timeoutMillis: 250 } } }, env).export
        .otlp,
    ).toMatchObject({ timeoutMillis: 250 });
  });

  it("NESTRIX_ENABLED false or 0 (any case) disables; other values do not", () => {
    for (const v of ["false", "FALSE", " False ", "0"]) {
      expect(isDisabledByEnv({ NESTRIX_ENABLED: v })).toBe(true);
      expect(resolveOptions({}, { NESTRIX_ENABLED: v }).enabled).toBe(false);
    }
    for (const v of ["true", "1", "", "no", undefined]) {
      expect(isDisabledByEnv({ NESTRIX_ENABLED: v })).toBe(false);
      expect(resolveOptions({}, { NESTRIX_ENABLED: v }).enabled).toBe(true);
    }
  });

  it("enabled: false disables; NESTRIX_ENABLED=false beats enabled: true", () => {
    expect(resolveOptions({ enabled: false }, none).enabled).toBe(false);
    expect(
      resolveOptions({ enabled: true }, { NESTRIX_ENABLED: "false" }).enabled,
    ).toBe(false);
    expect(
      resolveOptions({ enabled: false }, { NESTRIX_ENABLED: "true" }).enabled,
    ).toBe(false);
  });
});

describe("resolveOptions validation", () => {
  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects sampleRate %s",
    (sampleRate) => {
      expect(() => resolveOptions({ sampleRate }, none)).toThrow(/sampleRate/);
    },
  );

  it.each([0, 0.5, 1])("accepts sampleRate %s", (sampleRate) => {
    expect(resolveOptions({ sampleRate }, none).sampleRate).toBe(sampleRate);
  });

  it.each([
    ["maxQueueSize", 0],
    ["maxQueueSize", -1],
    ["maxQueueSize", 1.5],
    ["maxQueueSize", Number.NaN],
    ["maxExportBatchSize", 0],
    ["maxExportBatchSize", 2.5],
    ["scheduledDelayMillis", 0],
    ["scheduledDelayMillis", -5],
  ] as const)("rejects queue.%s = %s", (key, value) => {
    expect(() =>
      resolveOptions(
        { export: { queue: { maxQueueSize: 4096, [key]: value } } },
        none,
      ),
    ).toThrow(new RegExp(`export\\.queue\\.${key}`));
  });

  it("rejects maxExportBatchSize above maxQueueSize, accepts equal", () => {
    expect(() =>
      resolveOptions(
        { export: { queue: { maxQueueSize: 10, maxExportBatchSize: 11 } } },
        none,
      ),
    ).toThrow(/maxExportBatchSize.*must not exceed.*maxQueueSize/);
    expect(
      resolveOptions(
        { export: { queue: { maxQueueSize: 10, maxExportBatchSize: 10 } } },
        none,
      ).export.queue.maxExportBatchSize,
    ).toBe(10);
  });

  it("a small maxQueueSize alone conflicts with the default batch size", () => {
    expect(() =>
      resolveOptions({ export: { queue: { maxQueueSize: 100 } } }, none),
    ).toThrow(/maxExportBatchSize \(512\)/);
  });

  it("rejects a non-positive OTLP timeout", () => {
    expect(() =>
      resolveOptions(
        { export: { otlp: { endpoint: "http://e", timeoutMillis: 0 } } },
        none,
      ),
    ).toThrow(/timeoutMillis/);
  });

  it("validates even when disabled, so a typo fails everywhere", () => {
    expect(() =>
      resolveOptions({ enabled: false, sampleRate: 2 }, none),
    ).toThrow(/sampleRate/);
  });

  it("prefixes every error so it is recognisable in a startup crash", () => {
    expect(() => resolveOptions({ sampleRate: 5 }, none)).toThrow(
      /^Invalid Nestrix options:/,
    );
  });
});
