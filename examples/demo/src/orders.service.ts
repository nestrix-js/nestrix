import { Injectable, NotFoundException } from "@nestjs/common";
import { OrdersRepository } from "./orders.repository.js";

@Injectable()
export class OrdersService {
  constructor(private readonly repo: OrdersRepository) {}

  async list() {
    const orders = await this.repo.recent(6);
    const out = [];
    for (const o of orders) {
      out.push({ ...o, customer: await this.repo.customerName(o.customer_id) });
    }
    return out;
  }

  async one(id: number) {
    const order = await this.repo.byId(id);
    if (!order) throw new NotFoundException(`order ${id}`);
    return {
      ...order,
      customer: await this.repo.customerName(order.customer_id),
    };
  }

  report() {
    return this.repo.revenueReport();
  }

  archived() {
    return this.repo.archived();
  }
}
