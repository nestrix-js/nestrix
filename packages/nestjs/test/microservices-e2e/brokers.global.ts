// Vitest globalSetup for test/microservices-e2e (backlog P4-02): starts Redis, NATS, RabbitMQ,
// MQTT (mosquitto) and Kafka (KRaft, one node) with `docker run --rm -d` on 127.0.0.1 and provides
// their addresses as `inject("brokers")`. It does not wait for readiness; each test waits for its
// own broker (helpers.ts), so a run that touches none of them pays only for `docker run`.
//
// Docker unreachable: the tests skip with the printed reason, unless `CI` is set, where setup
// fails. `NESTRIX_CONTAINERS=0` skips them on purpose. Containers are removed by id at teardown.
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);

/** Official images. Tags checked with `docker manifest inspect`, 2026-11-11. */
export const BROKER_IMAGES = {
  redis: "redis:8-alpine",
  nats: "nats:2",
  rabbitmq: "rabbitmq:4",
  mqtt: "eclipse-mosquitto:2",
  kafka: "apache/kafka:4.1.0",
} as const;

export type BrokerKey = keyof typeof BROKER_IMAGES;

export interface BrokerAddress {
  readonly host: string;
  readonly port: number;
}

export type Brokers = { readonly skip?: string } & {
  readonly [K in BrokerKey]?: BrokerAddress;
};

declare module "vitest" {
  export interface ProvidedContext {
    brokers: Brokers;
  }
}

const HOST = "127.0.0.1";

async function docker(args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await run("docker", args, { timeout });
  return stdout.trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Starts one container publishing `inner` on a random host port; resolves the host port. */
async function start(
  ids: string[],
  image: string,
  inner: number,
  command: string[] = [],
): Promise<BrokerAddress> {
  const id = await docker([
    "run",
    "--rm",
    "-d",
    "-p",
    `${HOST}::${inner}`,
    image,
    ...command,
  ]);
  ids.push(id);
  const mapped = await docker(["port", id, `${inner}/tcp`], 30_000);
  const port = Number(mapped.split("\n")[0]?.split(":").pop());
  if (!Number.isInteger(port))
    throw new Error(`no port for ${image}: ${mapped}`);
  return { host: HOST, port };
}

/**
 * Kafka hands clients the address it advertises, so the container's port must be the host's:
 * pick a free port, map it 1:1 and advertise it (spike P4-S1).
 */
async function startKafka(ids: string[]): Promise<BrokerAddress> {
  const port = await freePort();
  const env = {
    KAFKA_NODE_ID: "1",
    KAFKA_PROCESS_ROLES: "broker,controller",
    KAFKA_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093",
    KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${HOST}:${port}`,
    KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
      "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
    KAFKA_CONTROLLER_QUORUM_VOTERS: "1@localhost:9093",
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: "0",
  };
  const id = await docker([
    "run",
    "--rm",
    "-d",
    "-p",
    `${HOST}:${port}:9092`,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    BROKER_IMAGES.kafka,
  ]);
  ids.push(id);
  return { host: HOST, port };
}

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
    console.log(`[nestrix microservices-e2e] tests skip: ${reason}`);
    project.provide("brokers", { skip: reason });
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
    const [redis, nats, rabbitmq, mqtt, kafka] = await Promise.all([
      start(ids, BROKER_IMAGES.redis, 6379),
      start(ids, BROKER_IMAGES.nats, 4222),
      start(ids, BROKER_IMAGES.rabbitmq, 5672),
      start(ids, BROKER_IMAGES.mqtt, 1883, [
        "mosquitto",
        "-c",
        "/mosquitto-no-auth.conf",
      ]),
      startKafka(ids),
    ]);
    project.provide("brokers", { redis, nats, rabbitmq, mqtt, kafka });
  } catch (error) {
    await teardown();
    const reason = `containers did not start (${(error as Error).message.split("\n")[0]})`;
    if (process.env.CI) throw new Error(reason);
    skip(reason);
    return;
  }
  return teardown;
}
