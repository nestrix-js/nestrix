// Q3a: the failure mode. Requires ESM modules that contain top-level await.
const path = require("node:path");

const cases = [
  ["ESM with TLA, required directly", "../tla/tla.mjs"],
  [
    "ESM without TLA that statically imports a module with TLA",
    "../tla/imports-tla.mjs",
  ],
  ["ESM without TLA (control)", "../tla/no-tla.mjs"],
];

console.log(`node ${process.version}`);
for (const [label, rel] of cases) {
  try {
    const m = require(path.join(__dirname, rel));
    console.log(
      `OK    ${label}: loaded, exports = ${JSON.stringify(Object.keys(m))}`,
    );
  } catch (err) {
    console.log(
      `FAIL  ${label}: ${err.code}: ${String(err.message).split("\n")[0]}`,
    );
  }
}
