import { Transport } from "@nestjs/microservices";
import mqtt from "mqtt";
import { describeTransport, waitUntil } from "./helpers.js";

// MQTT 5 on both sides: trace context travels as user properties; MQTT 3 carries none (P4-S1 Q1).
describeTransport({
  system: "mqtt",
  broker: "mqtt",
  ready: (a) =>
    waitUntil(
      async () => {
        const client = await mqtt.connectAsync(`mqtt://${a?.host}:${a?.port}`, {
          reconnectPeriod: 0,
          protocolVersion: 5,
        });
        await client.endAsync();
      },
      30_000,
      "mqtt",
    ),
  options: (a) => {
    const options = {
      transport: Transport.MQTT,
      options: { url: `mqtt://${a?.host}:${a?.port}`, protocolVersion: 5 },
    };
    return { client: options, server: options };
  },
});
