// Preload (`--import ./src/module-count.mjs`): records every ESM and CommonJS file the process
// loads, so the memory benchmark can tell what an import graph pulls in. Builtins are skipped.
import { registerHooks } from "node:module";

const loaded = new Set();
globalThis.__benchLoadedModules = loaded;
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("node:")) loaded.add(url);
    return nextLoad(url, context);
  },
});
