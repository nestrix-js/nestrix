import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { bootApp } from "../src/index.js";

// Defined here, in a .ts file transformed by Vitest, on purpose.
@Injectable()
class GreetingService {
  greet(): string {
    return "hi from service";
  }
}

@Controller()
class GreetingController {
  constructor(private readonly greeting: GreetingService) {}

  @Get("greet")
  greet(): string {
    return this.greeting.greet();
  }
}

@Module({ controllers: [GreetingController], providers: [GreetingService] })
class GreetingModule {}

describe("decorator metadata in test files", () => {
  it("emits design:paramtypes", () => {
    expect(
      Reflect.getMetadata("design:paramtypes", GreetingController),
    ).toEqual([GreetingService]);
  });

  it("injects a service into a controller defined in a test file", async () => {
    const booted = await bootApp("express", { module: GreetingModule });
    try {
      const res = await fetch(`${booted.baseUrl}/greet`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hi from service");
    } finally {
      await booted.close();
    }
  });
});
