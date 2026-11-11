import { ClientProxyFactory, Transport } from "@nestjs/microservices";
import { instrumentClient } from "../../src/index.js";

// A client made outside dependency injection. `ClientsModule` clients need nothing.
export const client = instrumentClient(
  ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: "localhost", port: 4000 },
  }),
);
