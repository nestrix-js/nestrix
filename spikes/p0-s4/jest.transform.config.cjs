// Variant: no --experimental-vm-modules. SWC rewrites the ESM-only packages (Nest 12,
// @nestrix/nestjs, the probe) to CommonJS inside Jest's own module system.
const base = require("./jest.config.cjs");

module.exports = {
  ...base,
  transform: {
    "\\.(m?js)$": ["@swc/jest", { module: { type: "commonjs" } }],
  },
  // pnpm keeps packages under node_modules/.pnpm/<name>/node_modules/<name>: transform
  // everything that is not a plain CommonJS dependency we know is safe.
  transformIgnorePatterns: [],
};
