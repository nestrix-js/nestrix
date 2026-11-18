/**
 * Issue #31 across real processes: each instance is `node dist/main.js` (the server's entry point)
 * in its own OS process against one PostgreSQL. `replicas.test.ts` runs several instances inside
 * one test process, where module-level state (such as the per-process salt this issue removed) is
 * shared and so cannot show the bug; this file can. Needs `pnpm build` first (`pnpm verify` and CI
 * build before testing); without `dist/main.js` it is skipped, and fails with `CI` set.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import { ADMIN_PW, SESSION_SECRET } from "./helpers.js";

const serverDir = fileURLToPath(new URL("../..", import.meta.url));
const entry = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const built = existsSync(entry);
if (!built && process.env.CI) {
  throw new Error(`${entry} is missing: run pnpm build before the tests`);
}
const notBuilt = built ? "" : "(dist/main.js missing: run pnpm build)";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Instance {
  base: string;
  port: number;
  stop(): Promise<void>;
}

const children = new Set<ChildProcess>();

async function startInstance(databaseUrl: string): Promise<Instance> {
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      NESTRIX_INGEST_AUTH: "none",
      NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
      NESTRIX_SESSION_SECRET: SESSION_SECRET,
      NESTRIX_TRUSTED_PROXIES: "127.0.0.1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`instance exited (${child.exitCode}): ${stderr}`);
    }
    try {
      const res = await fetch(`${base}/login.css`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`instance not ready: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => {
          children.delete(child);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}

let client = 0;

async function signIn(i: Instance): Promise<string> {
  client++;
  const res = await fetch(`${i.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: i.base,
      "x-forwarded-for": `192.0.2.${client}`,
    },
    body: new URLSearchParams({ password: ADMIN_PW }).toString(),
  });
  expect(res.status).toBe(303);
  const pair = (res.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  return pair.slice(pair.indexOf("=") + 1);
}

/** The cookie as `i` names it (replicas share one port; here each has its own). */
async function meta(i: Instance, value: string): Promise<number> {
  const res = await fetch(`${i.base}/api/v1/meta`, {
    headers: { cookie: `nestrix_admin_${i.port}=${value}` },
  });
  await res.arrayBuffer();
  return res.status;
}

describe.skipIf(noDatabase || !built)(
  `separate server processes ${skipReason}${notBuilt}`,
  () => {
    let db: TestDb;
    let a: Instance;
    let b: Instance;

    beforeAll(async () => {
      db = await createTestDb("processes");
      a = await startInstance(db.url);
      b = await startInstance(db.url);
    }, 90_000);

    afterAll(async () => {
      await a?.stop();
      await b?.stop();
      for (const c of children) c.kill("SIGKILL");
      await db?.drop();
    });

    it("A's session works on B, survives A's restart, and A's logout is refused by B at once", async () => {
      const kept = await signIn(a);
      const ended = await signIn(a);
      expect(await meta(a, kept)).toBe(200);
      expect(await meta(b, kept)).toBe(200);

      const out = await fetch(`${a.base}/logout`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: `nestrix_admin_${a.port}=${ended}`, origin: a.base },
      });
      expect(out.status).toBe(303);
      expect(await meta(b, ended)).toBe(401);

      await a.stop();
      a = await startInstance(db.url);
      expect(await meta(a, kept)).toBe(200);
      expect(await meta(a, ended)).toBe(401);
      expect(await meta(b, kept)).toBe(200);
    }, 60_000);
  },
);
