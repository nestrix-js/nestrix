// End to end against the real image: `docker compose up --build`, two example services
// (examples/jaeger: service-a calls service-b) with only OTEL_EXPORTER_OTLP_ENDPOINT set, one
// request, then one trace across both services through the query API.
//
//   NESTRIX_E2E_DOCKER=1 pnpm exec vitest run --project @nestrix/server test/e2e
//
// Opt-in: it builds an image and binds port 4318. Retention is covered by the container tests in
// test/storage/partitions.test.ts ("retention drops partitions ... older than the retention").
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.NESTRIX_E2E_DOCKER === "1";
const serverDir = fileURLToPath(new URL("../..", import.meta.url));
const exampleDir = fileURLToPath(
  new URL("../../../../examples/jaeger", import.meta.url),
);
const project = "nestrix-p506-e2e";
const base = "http://127.0.0.1:4318";
// Generated per run; the compose file reads it from the environment.
const adminPw = randomBytes(12).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const children: ChildProcess[] = [];
let composeUp = false;

function compose(args: string[], timeout = 480_000) {
  return spawnSync("docker", ["compose", "-p", project, ...args], {
    cwd: serverDir,
    env: { ...process.env, NESTRIX_ADMIN_PASSWORD: adminPw },
    encoding: "utf8",
    timeout,
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(
    `${what} not ready within ${ms} ms${last ? ` (${String(last)})` : ""}`,
  );
}

function startApp(name: string, port: number, env: Record<string, string>) {
  const child = spawn(process.execPath, [`dist/${name}.js`], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PORT: String(port),
      // The only Nestrix-related setting the example apps get.
      OTEL_EXPORTER_OTLP_ENDPOINT: base,
      ...env,
    },
    stdio: "ignore",
  });
  children.push(child);
}

async function login(): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: base,
    },
    body: new URLSearchParams({ password: adminPw }).toString(),
  });
  expect(res.status).toBe(303);
  return (res.headers.get("set-cookie") ?? "").split(";", 1)[0] as string;
}

interface Span {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
}

describe.skipIf(!enabled)(
  enabled
    ? "docker compose end to end"
    : "docker compose end to end (set NESTRIX_E2E_DOCKER=1; it builds an image and uses port 4318)",
  () => {
    let cookie = "";
    let portA = 0;

    beforeAll(async () => {
      const build = spawnSync("pnpm", ["--filter", "jaeger-example", "build"], {
        encoding: "utf8",
      });
      expect(build.status, build.stdout + build.stderr).toBe(0);

      const up = compose([
        "up",
        "--build",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
      ]);
      composeUp = true;
      expect(up.status, up.stdout + up.stderr).toBe(0);

      portA = await freePort();
      const portB = await freePort();
      startApp("service-b", portB, {});
      startApp("service-a", portA, {
        SERVICE_B_URL: `http://127.0.0.1:${portB}`,
      });
      await waitFor(
        "service-a",
        async () => (await fetch(`http://127.0.0.1:${portA}/call/0`)).ok,
        30_000,
      );
      cookie = await login();
    }, 600_000);

    afterAll(() => {
      for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
      if (composeUp) compose(["down", "-v", "--timeout", "5"], 120_000);
    }, 150_000);

    // biome-ignore lint/suspicious/noExplicitAny: JSON of the query API, checked field by field below
    const api = async (path: string): Promise<any> => {
      const res = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      return res.json();
    };

    it("rejects the query API without a session", async () => {
      expect((await fetch(`${base}/api/v1/traces`)).status).toBe(401);
    });

    it("stores one trace across both services and draws the edge between them", async () => {
      const res = await fetch(`http://127.0.0.1:${portA}/call/42`);
      expect(res.status).toBe(200);

      // Wait for the exporters' batches (about 5 s) to be ingested.
      const trace = await waitFor(
        "a cross-service trace",
        async () => {
          const list = await api("/api/v1/traces?service=service-a");
          for (const item of list.items as { traceId: string }[]) {
            const t = await api(`/api/v1/trace?id=${item.traceId}`);
            const names = (t.spans as Span[]).map((s) => s.name);
            if (
              names.some((n) => n.includes("/call/")) &&
              names.some((n) => n.includes("/items/"))
            )
              return t;
          }
          return undefined;
        },
        60_000,
      );

      // One trace holds the spans of both processes: B's server span is parented under A's client span.
      const spans = trace.spans as Span[];
      const clientA = spans.find(
        (s) => s.kind === "client" && s.name.includes("GET"),
      );
      const serverB = spans.find(
        (s) => s.kind === "server" && s.name.includes("/items/"),
      );
      expect(clientA).toBeDefined();
      expect(serverB?.parentSpanId).toBe(clientA?.spanId);

      const meta = await api("/api/v1/meta");
      expect(meta.mode).toBe("standalone");
      expect(meta.services).toEqual(
        expect.arrayContaining(["service-a", "service-b"]),
      );

      const map = await api("/api/v1/map");
      const ids = (map.nodes as { id: string }[]).map((n) => n.id);
      expect(ids).toEqual(
        expect.arrayContaining(["service:service-a", "service:service-b"]),
      );
      expect(map.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: "service:service-a",
            to: "service:service-b",
          }),
        ]),
      );
    }, 120_000);
  },
);
