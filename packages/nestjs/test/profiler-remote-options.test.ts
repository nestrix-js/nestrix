// P10-01: resolving `export.profiler`, and the identity the poller checks in with.
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import type { NestrixModuleOptions } from "../src/options.js";
import { instanceIdentity } from "../src/otel/resource.js";
import { resolveOptions } from "../src/resolve-options.js";

const remote = (
  options: NestrixModuleOptions,
  env: Record<string, string> = {},
) => resolveOptions(options, env).export.profiler;

describe("export.profiler", () => {
  it("is off by default, even with an endpoint", () => {
    expect(remote({ export: { otlp: { endpoint: "http://s:4318" } } })).toBe(
      false,
    );
  });

  it("throws on a non-boolean", () => {
    expect(() =>
      remote({ export: { profiler: "yes" as unknown as boolean } }),
    ).toThrow("export.profiler must be a boolean");
  });

  it("takes the option endpoint (trailing slashes dropped), the trace headers and timeout", () => {
    expect(
      remote(
        {
          export: {
            profiler: true,
            otlp: {
              endpoint: "http://server:4318//",
              headers: { "x-key": "opt" },
              timeoutMillis: 3000,
            },
          },
        },
        {
          OTEL_EXPORTER_OTLP_HEADERS: "x-env=generic,x-key=env",
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-traces=t",
        },
      ),
    ).toEqual({
      target: {
        baseUrl: "http://server:4318",
        headers: { "x-env": "generic", "x-key": "opt", "x-traces": "t" },
        timeoutMillis: 3000,
      },
    });
  });

  it("falls back to OTEL_EXPORTER_OTLP_ENDPOINT, default timeout 10 s", () => {
    expect(
      remote(
        { export: { profiler: true } },
        { OTEL_EXPORTER_OTLP_ENDPOINT: "https://ingest.example/" },
      ),
    ).toEqual({
      target: {
        baseUrl: "https://ingest.example",
        headers: {},
        timeoutMillis: 10_000,
      },
    });
  });

  it("a traces URL alone gives no base; otlp: false or no endpoint gives none", () => {
    expect(
      remote(
        { export: { profiler: true } },
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces" },
      ),
    ).toEqual({ target: undefined });
    expect(
      remote(
        { export: { profiler: true, otlp: false } },
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" },
      ),
    ).toEqual({ target: undefined });
    expect(remote({ export: { profiler: true } })).toEqual({
      target: undefined,
    });
  });
});

describe("instanceIdentity", () => {
  const config = {
    serviceName: "svc",
    serviceVersion: "1.0.0",
    resourceAttributes: {},
    otelResourceAttributes: undefined,
  };

  it("uses the owned provider's resource attributes as they are", () => {
    expect(
      instanceIdentity(config, {
        resourceAttributes: {
          "service.name": "from-resource",
          "service.instance.id": "abc",
          "service.version": "2",
          "host.name": "h1",
        },
      }),
    ).toEqual({
      service: "from-resource",
      instanceId: "abc",
      version: "2",
      host: "h1",
    });
  });

  it("without an owned provider: Nestrix's own resource values, a random id, os.hostname()", () => {
    const a = instanceIdentity(config, undefined);
    const b = instanceIdentity(config, { resourceAttributes: undefined });
    expect(a.service).toBe("svc");
    expect(a.version).toBe("1.0.0");
    expect(a.host).toBe(hostname());
    expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.instanceId).not.toBe(a.instanceId);
  });

  it("OTEL_RESOURCE_ATTRIBUTES host.name wins over os.hostname()", () => {
    expect(
      instanceIdentity(
        { ...config, otelResourceAttributes: "host.name=pod-7" },
        undefined,
      ).host,
    ).toBe("pod-7");
  });
});
