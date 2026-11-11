// Q5 runtime check, run against a host installed by q5-install.sh:
//   node scripts/q5-runtime.mjs <host dir> <case>
// cases:
//   host-sdk2     the host registers SDK 2 (NodeTracerProvider.register(), api 1.9.x,
//                 CommonJS copies); "Nestrix" uses whatever api and SDK resolve from
//                 inside node_modules/@nestrix-js/nestjs (ESM copies)
//   nestrix-only  no host provider; Nestrix registers an SDK 3 provider on the api
//                 the install gave it
//   mixed-api     the host registers through its api 1.9.x; Nestrix uses this spike's
//                 api 1.10.0 and SDK 3 (what a separate 1.10 copy for Nestrix would see)
//   mixed-api-diag-only
//                 the host only calls diag.setLogger() through its api 1.9.x; Nestrix
//                 uses this spike's api 1.10.0 and SDK 3
//   reverse-cm    the reverse: Nestrix's own api 1.10.0 registers only a context
//                 manager first, then the host sets a diag logger and registers SDK 2
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** name@version of the package that contains a resolved file (path or file: URL). */
function versionOf(file) {
  let dir = dirname(file.startsWith("file:") ? fileURLToPath(file) : file);
  while (dir !== dirname(dir)) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const j = JSON.parse(readFileSync(pj, "utf8"));
      if (j.name && j.version) return `${j.name}@${j.version}`;
    }
    dir = dirname(dir);
  }
  return "unknown";
}

const [hostDir, which] = process.argv.slice(2);
const hostRequire = createRequire(join(hostDir, "package.json"));
// realpath: under pnpm the package's own dependencies sit next to its real location.
const nxPkg = realpathSync(
  join(hostDir, "node_modules/@nestrix-js/nestjs/package.json"),
);
// ESM resolution from inside the Nestrix package, as its own `import` would see it:
// find the package directory by Node's node_modules lookup from there, then take
// its exports["."] "default" (ESM) target. (import.meta.resolve ignores a parent
// URL unless --experimental-import-meta-resolve is set.)
const nxRequire = createRequire(nxPkg);
const importFromNestrix = async (spec) => {
  for (const dir of nxRequire.resolve.paths(spec) ?? []) {
    const pj = join(dir, spec, "package.json");
    if (!existsSync(pj)) continue;
    const j = JSON.parse(readFileSync(pj, "utf8"));
    const dot = j.exports?.["."];
    const target =
      dot?.default?.default ?? dot?.default ?? dot?.import ?? j.main;
    const file = pathToFileURL(join(dir, spec, target)).href;
    return { mod: await import(file), file };
  }
  const error = new Error(`cannot resolve ${spec} from @nestrix-js/nestjs`);
  error.code = "ERR_MODULE_NOT_FOUND";
  throw error;
};

if (which === "reverse-cm") {
  // Review fix 2, the reverse direction: a Nestrix-owned api 1.10.0 copy (this
  // spike's) registers only a context manager first; then the SDK 2 host sets its
  // diag logger and calls NodeTracerProvider.register() through its api 1.9.x.
  const nx = await import("@opentelemetry/api");
  const { AsyncLocalStorageContextManager } = await import(
    "@opentelemetry/context-async-hooks"
  );
  const nxCm = nx.context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  const hostApi = hostRequire("@opentelemetry/api");
  const diag = [];
  const sink = (...a) => diag.push(String(a[0]).split("\n")[0]);
  const diagSet = hostApi.diag.setLogger(
    { error: sink, warn: sink, info() {}, debug() {}, verbose() {} },
    hostApi.DiagLogLevel.WARN,
  );
  const base = hostRequire("@opentelemetry/sdk-trace-base");
  const { NodeTracerProvider } = hostRequire("@opentelemetry/sdk-trace-node");
  const exporter = new base.InMemorySpanExporter();
  new NodeTracerProvider({
    spanProcessors: [new base.SimpleSpanProcessor(exporter)],
  }).register();
  const span = hostApi.trace.getTracer("host").startSpan("host-span");
  const hostSpanValid = hostApi.isSpanContextValid(span.spanContext());
  span.end();
  console.log(
    `RESULT ${JSON.stringify({
      case: which,
      node: process.version,
      hostApi: versionOf(hostRequire.resolve("@opentelemetry/api")),
      nestrixApi: versionOf(import.meta.resolve("@opentelemetry/api")),
      nxCm,
      diagSet,
      hostSpanValid,
      hostExported: exporter.getFinishedSpans().map((s) => s.name),
      diag,
    })}`,
  );
  process.exit(0);
}

const out = { case: which, node: process.version };
const diag = [];
const hostApi = hostRequire("@opentelemetry/api");
const sink = (...a) => diag.push(String(a[0]).split("\n")[0]);
if (which !== "nestrix-only") {
  hostApi.diag.setLogger(
    { error: sink, warn: sink, info() {}, debug() {}, verbose() {} },
    hostApi.DiagLogLevel.WARN,
  );
}
out.hostApi = versionOf(hostRequire.resolve("@opentelemetry/api"));

let hostExporter;
if (which === "host-sdk2" || which === "mixed-api") {
  const base = hostRequire("@opentelemetry/sdk-trace-base");
  const { NodeTracerProvider } = hostRequire("@opentelemetry/sdk-trace-node");
  hostExporter = new base.InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new base.SimpleSpanProcessor(hostExporter)],
  });
  provider.register(); // provider + AsyncLocalStorage context manager + W3C propagator
}

let nxApi;
let nxApiFile;
if (which.startsWith("mixed-api")) {
  nxApiFile = import.meta.resolve("@opentelemetry/api");
  nxApi = await import(nxApiFile);
} else {
  const r = await importFromNestrix("@opentelemetry/api");
  nxApi = r.mod;
  nxApiFile = r.file;
}
out.nestrixApi = versionOf(nxApiFile);
out.nestrixApiBuild = nxApiFile.split("/").pop();

// What Nestrix sees through its api copy.
const key = nxApi.createContextKey("probe");
out.nestrixSees = {
  contextManager: nxApi.context.with(
    nxApi.ROOT_CONTEXT.setValue(key, 1),
    () => nxApi.context.active().getValue(key) === 1,
  ),
  propagatorFields: nxApi.propagation.fields(),
};

if (which === "nestrix-only") {
  // As Nestrix's setup would: register an AsyncLocalStorage context manager (this
  // spike's copy of the class; it registers through Nestrix's api copy).
  const { AsyncLocalStorageContextManager } = await import(
    "@opentelemetry/context-async-hooks"
  );
  out.nestrixSetGlobalContextManager = nxApi.context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
}

try {
  let provider;
  let nxExporter;
  try {
    const r = which.startsWith("mixed-api")
      ? {
          mod: await import("@opentelemetry/sdk-trace"),
          file: import.meta.resolve("@opentelemetry/sdk-trace"),
        }
      : await importFromNestrix("@opentelemetry/sdk-trace");
    nxExporter = new r.mod.InMemorySpanExporter();
    provider = new r.mod.TracerProvider({
      spanProcessors: [new r.mod.SimpleSpanProcessor({ exporter: nxExporter })],
    });
    out.sdk3 = versionOf(r.file);
  } catch (error) {
    out.sdk3 = `not resolvable: ${error.code ?? error.message}`;
  }
  if (provider) {
    out.nestrixSetGlobalTracerProvider =
      nxApi.trace.setGlobalTracerProvider(provider);
  }

  // A server span and a child across an await, through Nestrix's api copy.
  const tracer = nxApi.trace.getTracer("nestrix-standin");
  const parent = tracer.startSpan("server");
  out.parentSpanValid = nxApi.isSpanContextValid(parent.spanContext());
  await nxApi.context.with(
    nxApi.trace.setSpan(nxApi.context.active(), parent),
    async () => {
      await new Promise((r) => setTimeout(r, 1));
      const child = tracer.startSpan("child");
      out.childParentMatches =
        (child.parentSpanContext?.spanId ?? child.parentSpanId) ===
        parent.spanContext().spanId;
      child.end();
    },
  );
  parent.end();
  out.hostExporterSpans = hostExporter
    ? hostExporter.getFinishedSpans().map((s) => s.name)
    : null;
  out.nestrixExporterSpans = nxExporter
    ? nxExporter.getFinishedSpans().map((s) => s.name)
    : null;
} catch (error) {
  out.error = `${error.name}: ${error.message}`;
}
out.diag = diag;
console.log(`RESULT ${JSON.stringify(out)}`);
