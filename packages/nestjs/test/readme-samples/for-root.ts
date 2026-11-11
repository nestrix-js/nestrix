import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    // Import NestrixModule before modules that register global interceptors.
    NestrixModule.forRoot({ serviceName: "my-api" }),
  ],
})
export class AppModule {}
