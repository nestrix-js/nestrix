// node scripts/resolve-from.mjs <file>: runs enablePg({ from: <file> }) and prints the result.
// Used to show resolution with and without NODE_PATH (pnpm's bin shims export one that
// includes node_modules/.pnpm/node_modules).
import { pathToFileURL } from "node:url";
import { enablePg } from "../dist/src/nestrix/pg.js";

const result = enablePg({ from: pathToFileURL(process.argv[2]).href });
process.stdout.write(
  `__RESOLVE__${JSON.stringify({ nodePath: process.env.NODE_PATH ?? null, result })}\n`,
);
