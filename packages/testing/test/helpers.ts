import { expect } from "vitest";

export async function expectRefused(baseUrl: string): Promise<void> {
  await expect(fetch(`${baseUrl}/hello`)).rejects.toThrow();
}
