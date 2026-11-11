// Starts the app in the current directory (`node dist/main.js`, so build first),
// waits for it, runs check-routes.mjs against it, and stops it.
// Run it from an example's directory, e.g. `pnpm --filter express-esm check:run`.
// Exit code is the check's. Optional: $ENTRY to start something other than dist/main.js.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const entry = process.env.ENTRY ?? "dist/main.js";

const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
  s.on("error", reject);
});
const base = `http://127.0.0.1:${port}`;

const app = spawn(process.execPath, [entry], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "inherit", "inherit"],
});
let exited = false;
app.on("exit", () => {
  exited = true;
});

async function waitUntilUp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`${entry} exited before it was ready`);
    try {
      await fetch(`${base}/hello`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("app did not come up within 30 s");
}

let code = 1;
try {
  await waitUntilUp();
  const check = spawn(
    process.execPath,
    [fileURLToPath(new URL("./check-routes.mjs", import.meta.url)), base],
    { stdio: "inherit" },
  );
  code = await new Promise((resolve) =>
    check.on("exit", (c) => resolve(c ?? 1)),
  );
} catch (err) {
  console.error(String(err));
} finally {
  if (!exited) {
    app.kill("SIGTERM");
    await new Promise((r) => app.on("exit", r));
  }
}
process.exit(code);
