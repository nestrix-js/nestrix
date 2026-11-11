// Q3 (start pause): how long v8.startCpuProfile() blocks the main thread, against the amount of
// compiled code, for a first and a second capture. Grows the code by loading and running the
// TypeScript compiler (a large body of JavaScript) over this workspace's files.
import { createRequire } from "node:module";
import v8 from "node:v8";

const require = createRequire(import.meta.url);
const codeMB = () => {
  const s = v8.getHeapCodeStatistics();
  return (
    Math.round(
      ((s.code_and_metadata_size + s.bytecode_and_metadata_size) / 1e6) * 10,
    ) / 10
  );
};
const timeStart = () => {
  const t = performance.now();
  const h = v8.startCpuProfile({ sampleInterval: 1 });
  const startMs = performance.now() - t;
  const t2 = performance.now();
  h.stop();
  return {
    startMs: Math.round(startMs * 10) / 10,
    stopMs: Math.round((performance.now() - t2) * 10) / 10,
  };
};

const rows = [];
const order = process.argv[2] ?? "small-first";
if (order === "small-first") {
  rows.push({
    phase: "bare process, 1st capture",
    codeMB: codeMB(),
    ...timeStart(),
  });
  rows.push({
    phase: "bare process, 2nd capture",
    codeMB: codeMB(),
    ...timeStart(),
  });
}
// Load and exercise a large body of code.
const ts = require(
  require.resolve("typescript", {
    paths: [new URL("../../..", import.meta.url).pathname],
  }),
);
const program = ts.createProgram(
  [new URL("../../../packages/nestjs/src/index.ts", import.meta.url).pathname],
  {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2024,
    experimentalDecorators: true,
    noEmit: true,
  },
);
ts.getPreEmitDiagnostics(program);
rows.push({
  phase: `after TypeScript typecheck, ${order === "small-first" ? "3rd" : "1st"} capture`,
  codeMB: codeMB(),
  ...timeStart(),
});
rows.push({
  phase: "after TypeScript typecheck, next capture",
  codeMB: codeMB(),
  ...timeStart(),
});
for (const r of rows) console.log(JSON.stringify(r));
