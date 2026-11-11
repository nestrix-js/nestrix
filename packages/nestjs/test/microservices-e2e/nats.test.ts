import { connect } from "@nats-io/transport-node";
import { Transport } from "@nestjs/microservices";
import { describeTransport, waitUntil } from "./helpers.js";

describeTransport({
  system: "nats",
  broker: "nats",
  ready: (a) =>
    waitUntil(
      async () => {
        const nc = await connect({ servers: `nats://${a?.host}:${a?.port}` });
        await nc.close();
      },
      30_000,
      "nats",
    ),
  options: (a) => {
    const options = {
      transport: Transport.NATS,
      options: { servers: [`nats://${a?.host}:${a?.port}`] },
    };
    return { client: options, server: options };
  },
});
