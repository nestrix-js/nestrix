import { Transport } from "@nestjs/microservices";
import { Redis } from "ioredis";
import { describeTransport, waitUntil } from "./helpers.js";

describeTransport({
  system: "redis",
  broker: "redis",
  ready: (a) =>
    waitUntil(
      async () => {
        const redis = new Redis({
          host: a?.host,
          port: a?.port,
          lazyConnect: true,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
        });
        redis.on("error", () => undefined);
        try {
          await redis.connect();
          await redis.ping();
        } finally {
          redis.disconnect();
        }
      },
      30_000,
      "redis",
    ),
  options: (a) => {
    const options = {
      transport: Transport.REDIS,
      options: { host: a?.host, port: a?.port },
    };
    return { client: options, server: options };
  },
});
