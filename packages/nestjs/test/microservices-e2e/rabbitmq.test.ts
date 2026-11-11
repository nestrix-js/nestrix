import { Transport } from "@nestjs/microservices";
import amqplib from "amqplib";
import { describeTransport, waitUntil } from "./helpers.js";

describeTransport({
  system: "rabbitmq",
  broker: "rabbitmq",
  ready: (a) =>
    waitUntil(
      async () => {
        const connection = await amqplib.connect(
          `amqp://${a?.host}:${a?.port}`,
        );
        await connection.close();
      },
      60_000,
      "rabbitmq",
    ),
  options: (a, unique) => {
    const options = {
      transport: Transport.RMQ,
      options: {
        urls: [`amqp://${a?.host}:${a?.port}`],
        queue: `e2e-${unique}`,
        queueOptions: { durable: true },
      },
    };
    return { client: options, server: options };
  },
});
