// Entry of the stand-in package. lib/ is copied from the spike's compiled
// src/nestrix/{guard,sql,tracing,pg}.js by scripts/install-fixtures.mjs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { trace } from "@opentelemetry/api";
import { enablePg, instrumentPgExports } from "./lib/pg.js";
import { finishedSpans, setupTracing } from "./lib/tracing.js";

const require = createRequire(import.meta.url);

/** What NestrixModule would do: own the provider, then resolve and wrap `pg`. */
export function enable() {
  setupTracing();
  // Resolves `pg` from this file's real location, as the published package would.
  return enablePg({ from: import.meta.url });
}

/** Every copy of pg/lib/index.js in the CommonJS module cache, with its version. */
export function loadedPgCopies() {
  const copies = [];
  for (const [file, mod] of Object.entries(require.cache)) {
    if (!/[\\/]node_modules[\\/]pg[\\/]lib[\\/]index\.js$/.test(file)) continue;
    let version = "?";
    try {
      version = JSON.parse(
        readFileSync(join(dirname(file), "..", "package.json"), "utf8"),
      ).version;
    } catch {}
    copies.push({ file, version, exports: mod?.exports });
  }
  return copies;
}

/** Candidate for nested copies: wrap every pg already in the module cache. */
export function instrumentLoadedPgCopies() {
  return loadedPgCopies().map((c) => ({
    file: c.file,
    version: c.version,
    newlyWrapped: c.exports
      ? instrumentPgExports(c.exports, `pg@${c.version}`)
      : false,
  }));
}

export function withSpan(name, fn) {
  return trace.getTracer("fixture").startActiveSpan(name, async (span) => {
    try {
      return { spanId: span.spanContext().spanId, result: await fn() };
    } finally {
      span.end();
    }
  });
}

export { finishedSpans };
