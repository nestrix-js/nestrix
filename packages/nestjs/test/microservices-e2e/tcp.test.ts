import { Transport } from "@nestjs/microservices";
import { freePort } from "../microservices/helpers.js";
import { describeTransport } from "./helpers.js";

// TCP needs no broker: the same scenario on a free local port.
const port = await freePort();
const options = {
  transport: Transport.TCP,
  options: { host: "127.0.0.1", port },
};

describeTransport({
  system: "tcp",
  ready: async () => undefined,
  options: () => ({ client: options, server: options }),
});
