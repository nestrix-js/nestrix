import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";
import { AppController } from "./app.controller.js";
import { OrdersRepository } from "./orders.repository.js";
import { OrdersService } from "./orders.service.js";
import { PricingService } from "./pricing.service.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      serviceName: "demo-shop",
      serviceVersion: "demo-1.0",
      // The demo's traffic generator sends `x-demo-user`; a real app would read req.user.
      user: (req) =>
        (req as { headers?: Record<string, string | undefined> }).headers?.[
          "x-demo-user"
        ],
    }),
  ],
  controllers: [AppController],
  providers: [OrdersService, OrdersRepository, PricingService],
})
export class AppModule {}
