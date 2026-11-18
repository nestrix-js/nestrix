// Preloaded with `node --import` by test/methods/switched-off.test.ts (D-99 review): makes loading
// the built `dist/runtime.js` fail, so `loadNestrixRuntime`'s rejection path runs for real.
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/dist/runtime.js")) {
      throw new Error("injected: dist/runtime.js failed to load");
    }
    return nextLoad(url, context);
  },
});
