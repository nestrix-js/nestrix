// Loaded with `node --import` by child-process tests so they can run src/*.ts directly
// through Node's type stripping: a relative `./x.js` that does not exist resolves to
// `./x.ts`, as tsc's nodenext resolution does at build time.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(url))) {
        const ts = new URL(
          specifier.replace(/\.js$/, ".ts"),
          context.parentURL,
        );
        if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
      }
    }
    return next(specifier, context);
  },
});
