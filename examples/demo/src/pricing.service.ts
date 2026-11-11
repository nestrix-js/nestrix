import { Injectable } from "@nestjs/common";

@Injectable()
export class PricingService {
  /** Calls the app's own /health over HTTP, so the map shows an outbound HTTP target. */
  async quote(base: string): Promise<{ price: number; upstream: number }> {
    const res = await fetch(`${base}/health`);
    await res.text();
    return {
      price: Math.round(Math.random() * 10000) / 100,
      upstream: res.status,
    };
  }
}
