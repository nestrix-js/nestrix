#!/usr/bin/env node
// Starts/stops the spike's databases. Names are prefixed `nestrix-s2-` and bound to
// random host ports on 127.0.0.1; the URLs are written to .db.json next to package.json.
// Throwaway local containers: no passwords (trust auth / empty root password),
// reachable from 127.0.0.1 only.
//   node scripts/containers.mjs up     # start (or reuse) and wait until ready
//   node scripts/containers.mjs down   # stop and remove
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = join(root, ".db.json");
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();

const containers = {
  pg: {
    name: "nestrix-s2-postgres",
    image: "postgres:18-alpine",
    port: 5432,
    env: ["POSTGRES_HOST_AUTH_METHOD=trust", "POSTGRES_DB=nestrix"],
    ready: ["pg_isready", "-U", "postgres", "-d", "nestrix", "-h", "127.0.0.1"],
    url: (p) => `postgres://postgres@127.0.0.1:${p}/nestrix`,
  },
  mysql: {
    name: "nestrix-s2-mysql",
    image: "mysql:8.4",
    port: 3306,
    env: ["MYSQL_ALLOW_EMPTY_PASSWORD=yes", "MYSQL_DATABASE=nestrix"],
    ready: ["mysql", "-uroot", "-h127.0.0.1", "-e", "SELECT 1"],
    url: (p) => `mysql://root@127.0.0.1:${p}/nestrix`,
  },
  redis: {
    name: "nestrix-s2-redis",
    image: "redis:8-alpine",
    port: 6379,
    env: [],
    ready: ["redis-cli", "ping"],
    url: (p) => `redis://127.0.0.1:${p}`,
  },
};

function running(name) {
  try {
    return docker("inspect", "-f", "{{.State.Running}}", name) === "true";
  } catch {
    return false;
  }
}

function hostPort(c) {
  const out = docker("port", c.name, `${c.port}/tcp`);
  return Number(out.split("\n")[0].split(":").pop());
}

async function up() {
  const urls = {};
  for (const [key, c] of Object.entries(containers)) {
    if (!running(c.name)) {
      try {
        docker("rm", "-f", c.name);
      } catch {}
      docker(
        "run",
        "-d",
        "--name",
        c.name,
        "-p",
        `127.0.0.1::${c.port}`,
        ...c.env.flatMap((e) => ["-e", e]),
        c.image,
      );
    }
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        execFileSync("docker", ["exec", c.name, ...c.ready], {
          stdio: "ignore",
        });
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`${c.name} not ready`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    urls[key] = c.url(hostPort(c));
    console.log(`${c.name} ready: ${urls[key]}`);
  }
  writeFileSync(dbFile, `${JSON.stringify(urls, null, 2)}\n`);
  console.log(`wrote ${dbFile}`);
}

function down() {
  for (const c of Object.values(containers)) {
    try {
      docker("rm", "-f", c.name);
      console.log(`removed ${c.name}`);
    } catch {
      console.log(`${c.name} not present`);
    }
  }
  if (existsSync(dbFile)) rmSync(dbFile);
}

const cmd = process.argv[2];
if (cmd === "up") await up();
else if (cmd === "down") down();
else {
  console.error("usage: containers.mjs up|down");
  process.exit(2);
}
