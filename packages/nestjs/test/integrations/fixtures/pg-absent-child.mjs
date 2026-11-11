// Child process for pg-absent.test.ts, run with NODE_PATH removed and `--import ts-hooks.mjs`
// so src/*.ts loads through type stripping. argv[2]: a file in a directory with no `pg` above it.
// Prints the pg integration's status and the failures counted, as JSON.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PG_INDEX = /[\\/]node_modules[\\/]pg[\\/]lib[\\/]index\.js$/;
const { enablePg, pgStatus, rescanPg } = await import(
  "../../../src/integrations/pg.ts"
);
const failures = [];
const dispose = enablePg(
  { logOnce() {}, countFailure: (where) => failures.push(where) },
  { resolveFrom: process.argv[2] },
);
rescanPg();
const status = pgStatus();
dispose();
process.stdout.write(
  JSON.stringify({
    status,
    failures,
    pgInCache: Object.keys(require.cache).filter((p) => PG_INDEX.test(p)),
  }),
);
