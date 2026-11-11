// Vitest globalSetup for the level 3 integration tests (backlog P3-01, "Rules for every task"):
// starts PostgreSQL 18, MySQL 8.4 and Redis 8 with `docker run --rm -d` on random 127.0.0.1 ports
// and provides their addresses as `inject("containers")`. It does not wait for the servers to
// accept connections, so test runs that never touch a database pay only for `docker run`; each
// container test waits for its own server (helpers.ts).
//
// Docker unreachable: the container tests skip with the printed reason, unless `CI` is set, where
// setup fails. `NESTRIX_CONTAINERS=0` skips them on purpose.
//
// Containers are removed by id at teardown (never by name pattern: other runs may be going on).
// Throwaway servers bound to 127.0.0.1 only, with no passwords.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);

/** Official images. Tags checked on Docker Hub (`docker manifest inspect`), 2026-11-11. */
export const IMAGES = {
  postgres: "postgres:18-alpine",
  mysql: "mysql:8.4",
  redis: "redis:8-alpine",
} as const;

export interface ContainerAddress {
  readonly host: string;
  readonly port: number;
}

export interface Containers {
  /** Why the container tests skip; absent when the containers were started. */
  readonly skip?: string;
  readonly postgres?: ContainerAddress;
  readonly mysql?: ContainerAddress;
  readonly redis?: ContainerAddress;
}

declare module "vitest" {
  export interface ProvidedContext {
    containers: Containers;
  }
}

async function docker(args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await run("docker", args, { timeout });
  return stdout.trim();
}

interface Spec {
  readonly key: "postgres" | "mysql" | "redis";
  readonly image: string;
  readonly port: number;
  readonly args: string[];
}

const SPECS: readonly Spec[] = [
  {
    key: "postgres",
    image: IMAGES.postgres,
    port: 5432,
    args: [
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-e",
      "POSTGRES_DB=nestrix",
      "--tmpfs",
      "/var/lib/postgresql",
    ],
  },
  {
    key: "mysql",
    image: IMAGES.mysql,
    port: 3306,
    args: [
      "-e",
      "MYSQL_ALLOW_EMPTY_PASSWORD=yes",
      "-e",
      "MYSQL_DATABASE=nestrix",
      "--tmpfs",
      "/var/lib/mysql",
    ],
  },
  { key: "redis", image: IMAGES.redis, port: 6379, args: [] },
];

/** Docker can still be starting on a fresh CI runner: retry for up to 60 s there, once locally. */
async function untilDockerReady(check: () => Promise<unknown>): Promise<void> {
  const deadline = Date.now() + (process.env.CI ? 60_000 : 0);
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

export default async function setup(project: TestProject) {
  const ids: string[] = [];
  const skip = (reason: string): void => {
    console.log(`[nestrix integrations] container tests skip: ${reason}`);
    project.provide("containers", { skip: reason });
  };
  if (process.env.NESTRIX_CONTAINERS === "0") {
    skip("NESTRIX_CONTAINERS=0");
    return;
  }
  try {
    await untilDockerReady(() =>
      docker(["info", "--format", "{{.ServerVersion}}"], 10_000),
    );
  } catch (error) {
    const reason = `Docker is not reachable (${(error as Error).message.split("\n")[0]})`;
    if (process.env.CI) throw new Error(`CI is set and ${reason}`);
    skip(reason);
    return;
  }

  const teardown = async () => {
    await Promise.all(
      ids.map((id) => docker(["rm", "-f", id], 30_000).catch(() => undefined)),
    );
  };

  try {
    const started = await Promise.all(
      SPECS.map(async (spec) => {
        const id = await docker([
          "run",
          "--rm",
          "-d",
          "-p",
          `127.0.0.1::${spec.port}`,
          ...spec.args,
          spec.image,
        ]);
        ids.push(id);
        const mapped = await docker(["port", id, `${spec.port}/tcp`], 30_000);
        const port = Number(mapped.split("\n")[0]?.split(":").pop());
        if (!Number.isInteger(port))
          throw new Error(`no port for ${spec.image}: ${mapped}`);
        return [spec.key, { host: "127.0.0.1", port }] as const;
      }),
    );
    project.provide("containers", Object.fromEntries(started) as Containers);
  } catch (error) {
    await teardown();
    const reason = `containers did not start (${(error as Error).message.split("\n")[0]})`;
    if (process.env.CI) throw new Error(reason);
    skip(reason);
    return;
  }
  return teardown;
}
