import { type ClientProxy, Transport } from "@nestjs/microservices";
import { Kafka } from "kafkajs";
import { describeTransport, waitUntil } from "./helpers.js";

// Kafka needs its topics before the consumers subscribe, and the reply topic subscribed before the
// client connects. Topics are created from the host (the broker advertises the host port).
describeTransport({
  system: "kafka",
  broker: "kafka",
  ready: (a) =>
    waitUntil(
      async () => {
        const admin = new Kafka({
          clientId: "e2e-admin",
          brokers: [`${a?.host}:${a?.port}`],
          logLevel: 0,
          retry: { retries: 0 },
        }).admin();
        await admin.connect();
        try {
          await admin.createTopics({
            waitForLeaders: true,
            topics: ["sum", "sum.reply", "evt"].map((topic) => ({
              topic,
              numPartitions: 1,
            })),
          });
        } finally {
          await admin.disconnect();
        }
      },
      90_000,
      "kafka",
    ),
  options: (a, unique) => {
    const kafka = {
      transport: Transport.KAFKA,
      options: {
        client: {
          clientId: `e2e-${unique}`,
          brokers: [`${a?.host}:${a?.port}`],
          logLevel: 0,
        },
        consumer: { groupId: `e2e-${unique}` },
      },
    };
    return { client: kafka, server: kafka };
  },
  prepareClient: async (client: ClientProxy) => {
    (
      client as unknown as { subscribeToResponseOf(p: string): void }
    ).subscribeToResponseOf("sum");
    await client.connect();
    await new Promise((r) => setTimeout(r, 1500)); // let the reply consumer join its group
  },
});
