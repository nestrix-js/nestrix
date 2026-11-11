/**
 * Vitest globalSetup: one Postgres 18 container for the storage tests (random host port bound to
 * 127.0.0.1, started with `--rm`, data on tmpfs, trust auth since it is a throwaway local
 * instance). Provides `pgAdminUrl` (the `postgres` database; each test file creates its own
 * database from it) or `pgSkipReason` when Docker is not reachable. With `CI` set, a missing
 * Docker fails the run instead of skipping.
 *
 * Teardown stops only the container this setup started, by id (`--rm` then removes it).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);
const IMAGE = "postgres:18-alpine";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgSkipReason: string;
  }
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { timeout: 180_000 });
  return stdout.trim();
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  try {
    await docker("version", "--format", "{{.Server.Version}}");
  } catch (error) {
    const reason = `Docker is not reachable (${(error as Error).message.split("\n")[0]})`;
    if (process.env.CI) {
      throw new Error(`storage tests need Docker in CI: ${reason}`);
    }
    console.warn(`[storage tests] skipped: ${reason}`);
    project.provide("pgAdminUrl", "");
    project.provide("pgSkipReason", reason);
    return async () => {};
  }

  const id = await docker(
    "run",
    "--rm",
    "-d",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql",
    IMAGE,
    "-c",
    "fsync=off",
    "-c",
    "max_connections=200",
  );
  const teardown = async () => {
    await docker("stop", "--time", "2", id).catch(() => undefined);
  };
  try {
    const mapping = await docker("port", id, "5432/tcp");
    const port = mapping.split("\n")[0]?.split(":").pop();
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    // The image initialises, restarts, then listens on TCP: wait for a real query.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const client = new pg.Client({ connectionString: url });
      try {
        await client.connect();
        await client.query("SELECT 1");
        await client.end();
        break;
      } catch (error) {
        await client.end().catch(() => undefined);
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    project.provide("pgAdminUrl", url);
    project.provide("pgSkipReason", "");
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
