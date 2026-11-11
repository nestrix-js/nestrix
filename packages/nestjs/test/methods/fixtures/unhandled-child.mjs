// Run by wrap.test.ts in a child process (Vitest intercepts unhandled rejections): counts
// 'unhandledRejection' events for an ignored rejected promise, unwrapped and through a level 2
// wrapper. Loaded with `--import ../../fixtures/ts-hooks.mjs` so `src/*.ts` runs directly.
import {
  configureMethods,
  nestrixInstanceDecorator,
} from "../../../src/methods/registry.ts";

class Failing {
  async fail() {
    await Promise.resolve();
    throw new Error("ignored");
  }
}

configureMethods(
  { enabled: true, include: [Failing], exclude: [], enhancers: [] },
  [],
);

const counts = { unwrapped: 0, wrapped: 0 };
let current = "unwrapped";
process.on("unhandledRejection", () => {
  counts[current]++;
});
const tick = () => new Promise((r) => setTimeout(r, 20));

new Failing().fail();
await tick();
current = "wrapped";
const wrapped = nestrixInstanceDecorator(new Failing());
if (!Object.hasOwn(wrapped, "fail")) throw new Error("not wrapped");
wrapped.fail();
await tick();
console.log(JSON.stringify(counts));
