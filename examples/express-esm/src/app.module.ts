import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { PrivateController } from "./private.controller.js";

/** No adapter imports: the same module is booted on Express, Fastify and platform-node. */
@Module({ controllers: [AppController, PrivateController] })
export class AppModule {}
