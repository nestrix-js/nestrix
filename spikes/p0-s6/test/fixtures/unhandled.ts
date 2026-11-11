// Run by q4-awkward.test.ts in a child process with --experimental-strip-types (unflagged only from Node 22.18).
// Counts 'unhandledRejection' events for an ignored rejected promise: unwrapped, and wrapped in each mode.
import { makeWrapper } from "../../src/wrap.ts";

async function failing(): Promise<never> {
  await Promise.resolve();
  throw new Error("ignored");
}

const counts: Record<string, number> = { unwrapped: 0, derived: 0, side: 0 };
let current = "unwrapped";
process.on("unhandledRejection", () => {
  counts[current] = (counts[current] ?? 0) + 1;
});

const tick = () => new Promise((r) => setTimeout(r, 20));

failing();
await tick();
current = "derived";
makeWrapper(failing, "failing", { strategy: "own", promiseMode: "derived" })();
await tick();
current = "side";
makeWrapper(failing, "failing", { strategy: "own", promiseMode: "side" })();
await tick();
console.log(JSON.stringify(counts));
