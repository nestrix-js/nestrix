import { Injectable } from "@nestjs/common";
import { Span, withSpan } from "../../src/index.js";

@Injectable()
export class BillingService {
  // The span is named "billing.reconcile". Without an argument it is "BillingService.reconcile".
  @Span("billing.reconcile")
  async reconcile(): Promise<number> {
    return 42;
  }

  async loadRates(): Promise<number[]> {
    return withSpan("load-rates", async (span) => {
      span.setAttribute("rates.source", "cache");
      return [1.1, 1.2];
    });
  }
}
