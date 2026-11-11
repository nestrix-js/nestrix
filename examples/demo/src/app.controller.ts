import { Controller, Get, Headers, Param, ParseIntPipe } from "@nestjs/common";
import { OrdersService } from "./orders.service.js";
import { PricingService } from "./pricing.service.js";

@Controller()
export class AppController {
  constructor(
    private readonly orders: OrdersService,
    private readonly pricing: PricingService,
  ) {}

  @Get("health")
  health() {
    return { ok: true };
  }

  @Get("orders")
  list() {
    return this.orders.list();
  }

  @Get("orders/:id")
  one(@Param("id", ParseIntPipe) id: number) {
    return this.orders.one(id);
  }

  @Get("reports/revenue")
  report() {
    return this.orders.report();
  }

  @Get("archive")
  archive() {
    return this.orders.archived();
  }

  @Get("quote")
  quote(@Headers("host") host: string) {
    return this.pricing.quote(`http://${host}`);
  }
}
