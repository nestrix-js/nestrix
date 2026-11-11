// The code samples in packages/nestjs/README.md live in test/readme-samples/*.ts, where
// `pnpm typecheck` compiles them against the real exports. This test keeps the README text and
// those files identical, and checks that the README documents every option.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = new URL(".", import.meta.url);
const readme = readFileSync(new URL("../README.md", here), "utf8");

// The README shows the package name and `./app.module`; the files import the source tree.
function forReadme(source: string): string {
  return source
    .replaceAll("../../src/index.js", "@nestrix/nestjs")
    .replaceAll("./for-root.js", "./app.module")
    .trimEnd();
}

function readmeSamples(): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /<!-- sample: ([a-z-]+) -->\n\n```ts\n([\s\S]*?)\n```/g;
  for (const match of readme.matchAll(pattern)) {
    found.set(match[1] as string, match[2] as string);
  }
  return found;
}

describe("README samples", () => {
  const files = readdirSync(new URL("readme-samples/", here))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -3));
  const samples = readmeSamples();

  it("has a sample file for every sample in the README, and the reverse", () => {
    expect([...samples.keys()].sort()).toEqual([...files].sort());
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s: README text equals the typechecked file", (name) => {
    const file = readFileSync(
      new URL(`readme-samples/${name}.ts`, here),
      "utf8",
    );
    expect(samples.get(name)).toBe(forReadme(file));
  });

  it("has no unlabelled TypeScript block", () => {
    const blocks = readme.match(/```ts\n/g)?.length ?? 0;
    expect(blocks).toBe(samples.size);
  });
});

// Every key of NestrixModuleOptions and its parts (src/options.ts). A type cannot be listed at
// run time, so a new option means adding it here, which fails until the README documents it.
const OPTIONS = [
  "enabled",
  "serviceName",
  "resourceAttributes",
  "sampleRate",
  "export",
  "export.otlp",
  "export.otlp.endpoint",
  "export.otlp.headers",
  "export.otlp.timeoutMillis",
  "export.queue",
  "export.queue.maxQueueSize",
  "export.queue.maxExportBatchSize",
  "export.queue.scheduledDelayMillis",
  "ignore",
  "ignore.paths",
  "ignore.outgoing",
  "http",
  "http.requestHeaders",
  "http.responseHeaders",
  "http.redactQueryKeys",
  "redact",
  "ui",
  "ui.enabled",
  "ui.path",
  "ui.auth",
  "ui.startupToken",
  "store",
  "store.maxTraces",
  "store.maxBytes",
  "logs",
  "logs.export",
  "metrics",
  "metrics.runtime",
  "serviceVersion",
  "user",
  "methods",
  "methods.include",
  "methods.exclude",
  "methods.enhancers",
  "integrations",
  "integrations.pg",
  "integrations.mysql2",
  "integrations.ioredis",
];

describe("README options", () => {
  it.each(OPTIONS)("documents `%s`", (option) => {
    expect(readme).toContain(`| \`${option}\` |`);
  });

  it("lists every environment variable Nestrix reads", () => {
    for (const name of [
      "NESTRIX_ENABLED",
      "OTEL_SERVICE_NAME",
      "OTEL_RESOURCE_ATTRIBUTES",
      "GIT_SHA",
      "npm_package_version",
      "NODE_ENV",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
      "OTEL_METRIC_EXPORT_INTERVAL",
    ]) {
      expect(readme).toContain(`| \`${name}\` |`);
    }
  });
});
